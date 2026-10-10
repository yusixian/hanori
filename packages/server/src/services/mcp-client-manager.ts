import { randomUUID } from "node:crypto";
import { McpToolCallError } from "@cos-tool-bot/shared";
import type { Database } from "@cos-tool-bot/database";
import { mcpServers } from "@cos-tool-bot/database";
import type { McpServerStatus, McpServerToolInfo } from "@cos-tool-bot/shared";
import type { McpToolEntry } from "@cos-tool-bot/bot";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { eq } from "drizzle-orm";
import type { Logger } from "pino";
import { redactDiagnostic } from "./run-redaction.js";
import { tryDecrypt } from "../utils/crypto.js";

interface McpClientEntry {
  client?: Client;
  lifetime: AbortController;
  attempt?: Promise<void>;
  checking?: boolean;
  tools: McpServerToolInfo[];
  toolNamePrefix: string | null;
  connected: boolean;
  lastConnectedAt: string | null;
  error: string | null;
  adminOnly: boolean;
  retryTimeout: ReturnType<typeof setTimeout> | null;
  retryCount: number;
}

const MAX_RETRIES = 10;
const CALL_TOOL_TIMEOUT_MS = 10 * 60 * 1000;

/**
 * GitHub MCP servers act with the credentials in their configured headers, so only Bot admins get
 * their tools.
 */
export function isAdminOnlyMcpServer(server: { presetId: string | null; url: string }): boolean {
  if (server.presetId === "github") return true;
  try {
    const hostname = new URL(server.url).hostname.toLowerCase();
    return (
      hostname === "github.com" ||
      hostname.endsWith(".github.com") ||
      hostname === "githubcopilot.com" ||
      hostname.endsWith(".githubcopilot.com")
    );
  } catch {
    return false;
  }
}

export class McpClientManager {
  private clients = new Map<number, McpClientEntry>();
  private destroyed = false;
  private healthCheckInterval: ReturnType<typeof setInterval> | null = null;

  constructor(
    private db: Database,
    private logger: Logger,
    private encryptionKey: string,
  ) {}

  async connectAll() {
    const servers = await this.db.select().from(mcpServers).where(eq(mcpServers.isActive, true));
    if (servers.length === 0) return;

    await Promise.allSettled(servers.map((server) => this.connect(server.id)));

    if (!this.destroyed) this.ensureHealthCheck();
  }

  private ensureHealthCheck() {
    if (this.healthCheckInterval) return;
    this.healthCheckInterval = setInterval(() => this.healthCheck(), 60_000);
  }

  connect(serverId: number): Promise<void> {
    if (this.destroyed) return Promise.reject(new Error("MCP manager is stopped"));
    const previous = this.clients.get(serverId);
    if (previous?.attempt) return previous.attempt;
    const entry: McpClientEntry = {
      lifetime: new AbortController(),
      tools: [],
      toolNamePrefix: null,
      connected: false,
      lastConnectedAt: null,
      error: null,
      adminOnly: false,
      retryTimeout: null,
      retryCount: 0,
    };
    // Publish before the first await so disconnect also invalidates pending DB/SDK work.
    this.clients.set(serverId, entry);
    return this.startAttempt(serverId, entry, previous ? this.closeEntry(previous) : undefined);
  }

  private isCurrent(serverId: number, entry: McpClientEntry): boolean {
    return !this.destroyed && this.clients.get(serverId) === entry;
  }

  private startAttempt(
    serverId: number,
    entry: McpClientEntry,
    closing?: Promise<void>,
  ): Promise<void> {
    if (entry.attempt) return entry.attempt;
    const attempt = this.connectInner(serverId, entry, closing).finally(() => {
      if (entry.attempt === attempt) entry.attempt = undefined;
    });
    entry.attempt = attempt;
    return attempt;
  }

  private async connectInner(serverId: number, entry: McpClientEntry, closing?: Promise<void>) {
    let client: Client | undefined;
    try {
      await closing;
      if (!this.isCurrent(serverId, entry)) return;
      const previousClient = entry.client;
      entry.client = undefined;
      await previousClient?.close().catch(() => {});
      if (!this.isCurrent(serverId, entry)) return;
      const [server] = await this.db.select().from(mcpServers).where(eq(mcpServers.id, serverId));
      if (!this.isCurrent(serverId, entry)) return;
      if (!server || !server.isActive) {
        await this.disconnect(serverId);
        return;
      }
      let headers: Record<string, string> | undefined;
      if (server.encryptedHeaders) {
        const raw = tryDecrypt(server.encryptedHeaders, this.encryptionKey);
        if (raw) {
          try {
            headers = JSON.parse(raw);
          } catch {
            this.logger.warn(`Failed to parse headers for MCP server ${serverId}`);
          }
        }
      }
      const url = new URL(server.url);
      const transport =
        server.transport === "streamable-http"
          ? new StreamableHTTPClientTransport(url, {
              requestInit: headers ? { headers } : undefined,
            })
          : new SSEClientTransport(url, { requestInit: headers ? { headers } : undefined });
      client = new Client({ name: "Hanori", version: "1.0.0" });
      entry.client = client;
      entry.toolNamePrefix = server.toolNamePrefix;
      entry.adminOnly = isAdminOnlyMcpServer(server);
      const result = await this.connectAndDiscover(client, transport, entry.lifetime.signal);
      if (!this.isCurrent(serverId, entry)) {
        await client.close().catch(() => {});
        return;
      }
      entry.tools = (result.tools ?? []).map((t) => ({
        name: t.name,
        description: t.description ?? "",
        inputSchema: (t.inputSchema ?? {}) as Record<string, unknown>,
        readOnlyHint: t.annotations?.readOnlyHint === true,
      }));
      entry.connected = true;
      entry.error = null;
      entry.lastConnectedAt = new Date().toISOString();
      entry.retryCount = 0;
      this.ensureHealthCheck();
      this.logger.info(`MCP server "${server.name}" connected (${entry.tools.length} tools)`);
    } catch {
      await client?.close().catch(() => {});
      if (!this.isCurrent(serverId, entry)) return;
      entry.client = undefined;
      entry.connected = false;
      entry.error = "Connection failed";
      this.logger.error(`MCP server ${serverId} connection failed`);
      this.scheduleRetry(serverId, entry);
    }
  }

  private async connectAndDiscover(
    client: Client,
    transport: SSEClientTransport | StreamableHTTPClientTransport,
    lifetime: AbortSignal,
  ) {
    const deadline = new AbortController();
    const signal = AbortSignal.any([lifetime, deadline.signal]);
    const timer = setTimeout(() => deadline.abort(new Error("MCP connection timed out")), 30_000);
    let onAbort: (() => void) | undefined;
    try {
      signal.throwIfAborted();
      const aborted = new Promise<never>((_, reject) => {
        onAbort = () => reject(new Error("MCP connection interrupted"));
        signal.addEventListener("abort", onAbort, { once: true });
      });
      const connecting = (async () => {
        await client.connect(transport, { signal });
        // SDK transport.start() can outlive cancellation (e.g. SSE without endpoint).
        if (signal.aborted) {
          await client.close().catch(() => {});
          signal.throwIfAborted();
        }
        return client.listTools(undefined, { signal });
      })();
      return await Promise.race([connecting, aborted]);
    } finally {
      clearTimeout(timer);
      if (onAbort) signal.removeEventListener("abort", onAbort);
    }
  }

  private scheduleRetry(serverId: number, entry: McpClientEntry) {
    if (!this.isCurrent(serverId, entry) || entry.retryTimeout) return;
    if (entry.retryCount >= MAX_RETRIES) {
      entry.error = `Gave up after ${MAX_RETRIES} retries`;
      this.logger.error(
        `MCP server ${serverId}: gave up reconnecting after ${MAX_RETRIES} retries`,
      );
      return;
    }
    const delay = Math.min(1000 * 2 ** entry.retryCount, 300_000);
    entry.retryCount++;
    entry.retryTimeout = setTimeout(() => {
      entry.retryTimeout = null;
      if (this.isCurrent(serverId, entry)) void this.startAttempt(serverId, entry);
    }, delay);
  }

  private async closeEntry(entry: McpClientEntry) {
    if (entry.retryTimeout) clearTimeout(entry.retryTimeout);
    entry.retryTimeout = null;
    entry.connected = false;
    entry.lifetime.abort(new Error("MCP connection stopped"));
    await entry.client?.close().catch(() => {});
  }

  async disconnect(serverId: number) {
    const entry = this.clients.get(serverId);
    this.clients.delete(serverId);
    if (entry) await this.closeEntry(entry);
  }

  async destroyAll() {
    this.destroyed = true;
    if (this.healthCheckInterval) clearInterval(this.healthCheckInterval);
    this.healthCheckInterval = null;
    const entries = [...this.clients.values()];
    this.clients.clear();
    await Promise.all(entries.map((entry) => this.closeEntry(entry)));
  }

  getToolsForServers(serverIds: number[]): McpToolEntry[] {
    const result: McpToolEntry[] = [];

    for (const id of serverIds) {
      const entry = this.clients.get(id);
      if (!entry?.connected) continue;

      for (const tool of entry.tools) {
        result.push({
          serverId: id,
          name: tool.name,
          description: tool.description,
          inputSchema: tool.inputSchema,
          prefix: entry.toolNamePrefix ?? undefined,
          adminOnly: entry.adminOnly,
          readOnlyHint: tool.readOnlyHint,
        });
      }
    }

    return result;
  }

  async callTool(
    serverId: number,
    toolName: string,
    args: unknown,
    signal?: AbortSignal,
  ): Promise<unknown> {
    const requestId = randomUUID();
    if (signal?.aborted)
      throw new McpToolCallError("cancelled", requestId, "MCP request cancelled before sending");
    const entry = this.clients.get(serverId);
    if (!entry?.connected || !entry.client) {
      throw new McpToolCallError("failed", requestId, `MCP server ${serverId} is not connected`);
    }
    const controller = new AbortController();
    const callSignal = AbortSignal.any([
      entry.lifetime.signal,
      controller.signal,
      ...(signal ? [signal] : []),
    ]);
    let rejectAbort: (() => void) | undefined;
    const timer = setTimeout(
      () => controller.abort(new Error("MCP tool call timed out")),
      CALL_TOOL_TIMEOUT_MS,
    );
    try {
      const aborted = new Promise<never>((_, reject) => {
        rejectAbort = () => reject(new Error("MCP request interrupted"));
        callSignal.addEventListener("abort", rejectAbort, { once: true });
      });
      const result = await Promise.race([
        entry.client.callTool(
          { name: toolName, arguments: args as Record<string, unknown> },
          undefined,
          {
            signal: callSignal,
            timeout: CALL_TOOL_TIMEOUT_MS,
            maxTotalTimeout: CALL_TOOL_TIMEOUT_MS,
          },
        ),
        aborted,
      ]);
      callSignal.throwIfAborted();
      if (result.isError) {
        const details = Array.isArray(result.content)
          ? result.content
              .filter((part) => part.type === "text" && typeof part.text === "string")
              .map((part) => part.text)
              .join("\n")
          : "";
        const safe = String(redactDiagnostic(details || "MCP tool reported an error"));
        throw new McpToolCallError(
          "failed",
          requestId,
          safe.length > 4096 ? safe.slice(0, 4096) + "… [truncated]" : safe,
        );
      }
      if (result.content && Array.isArray(result.content)) {
        const textParts = result.content
          .filter((c): c is { type: "text"; text: string } => c.type === "text")
          .map((c) => c.text);
        if (textParts.length === 1) return textParts[0];
        if (textParts.length > 1) return textParts.join("\n");
      }
      return result.content;
    } catch (error) {
      if (error instanceof McpToolCallError) throw error;
      // Transport errors cannot prove that a remote write did not happen.
      throw new McpToolCallError(
        "unknown",
        requestId,
        "MCP operation outcome is unknown; verify remotely before retrying",
      );
    } finally {
      clearTimeout(timer);
      if (rejectAbort) callSignal.removeEventListener("abort", rejectAbort);
    }
  }

  getStatus(serverId?: number): McpServerStatus[] {
    if (serverId != null) {
      const entry = this.clients.get(serverId);
      return [
        {
          serverId,
          connected: entry?.connected ?? false,
          toolCount: entry?.tools.length ?? 0,
          tools: entry?.tools ?? [],
          lastConnectedAt: entry?.lastConnectedAt ?? null,
          error: entry?.error ?? null,
        },
      ];
    }

    return [...this.clients.entries()].map(([id, entry]) => ({
      serverId: id,
      connected: entry.connected,
      toolCount: entry.tools.length,
      tools: entry.tools,
      lastConnectedAt: entry.lastConnectedAt,
      error: entry.error,
    }));
  }

  private async healthCheck() {
    const checks = [...this.clients.entries()]
      .filter(([, entry]) => entry.connected && entry.client && !entry.checking)
      .map(async ([serverId, entry]) => {
        entry.checking = true;
        const client = entry.client!;
        try {
          const result = await client.listTools(undefined, { signal: entry.lifetime.signal });
          if (!this.isCurrent(serverId, entry) || entry.client !== client) return;
          entry.tools = (result.tools ?? []).map((t) => ({
            name: t.name,
            description: t.description ?? "",
            inputSchema: (t.inputSchema ?? {}) as Record<string, unknown>,
            readOnlyHint: t.annotations?.readOnlyHint === true,
          }));
        } catch {
          if (!this.isCurrent(serverId, entry) || entry.client !== client) return;
          entry.connected = false;
          entry.error = "Health check failed";
          entry.retryCount = 0;
          this.logger.warn(`MCP server ${serverId} health check failed, reconnecting...`);
          this.scheduleRetry(serverId, entry);
        } finally {
          entry.checking = false;
        }
      });
    await Promise.allSettled(checks);
  }
}
