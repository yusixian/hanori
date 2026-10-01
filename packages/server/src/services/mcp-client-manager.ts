import type { Database } from "@cos-tool-bot/database";
import { mcpServers } from "@cos-tool-bot/database";
import type { McpServerStatus, McpServerToolInfo } from "@cos-tool-bot/shared";
import type { McpToolEntry } from "@cos-tool-bot/bot";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { eq } from "drizzle-orm";
import type { Logger } from "pino";
import { tryDecrypt } from "../utils/crypto.js";

interface McpClientEntry {
  client: Client;
  transport: SSEClientTransport | StreamableHTTPClientTransport;
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
const CALL_TOOL_TIMEOUT_MS = 5 * 60 * 1000;

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
  private connecting = new Set<number>();
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

    this.ensureHealthCheck();
  }

  private ensureHealthCheck() {
    if (this.healthCheckInterval) return;
    this.healthCheckInterval = setInterval(() => this.healthCheck(), 60_000);
  }

  async connect(serverId: number) {
    if (this.connecting.has(serverId)) return;
    this.connecting.add(serverId);
    try {
      await this.connectInner(serverId);
    } finally {
      this.connecting.delete(serverId);
    }
  }

  private async connectInner(serverId: number) {
    await this.disconnect(serverId);

    const [server] = await this.db.select().from(mcpServers).where(eq(mcpServers.id, serverId));
    if (!server) throw new Error(`MCP server ${serverId} not found`);
    if (!server.isActive) throw new Error(`MCP server ${serverId} is inactive`);

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
        ? new StreamableHTTPClientTransport(url, { requestInit: headers ? { headers } : undefined })
        : new SSEClientTransport(url, { requestInit: headers ? { headers } : undefined });

    const client = new Client({ name: "Hanori", version: "1.0.0" });

    const entry: McpClientEntry = {
      client,
      transport,
      tools: [],
      toolNamePrefix: server.toolNamePrefix,
      connected: false,
      lastConnectedAt: null,
      error: null,
      adminOnly: isAdminOnlyMcpServer(server),
      retryTimeout: null,
      retryCount: 0,
    };

    try {
      await client.connect(transport);
      const result = await client.listTools();
      entry.tools = (result.tools ?? []).map((t) => ({
        name: t.name,
        description: t.description ?? "",
        inputSchema: (t.inputSchema ?? {}) as Record<string, unknown>,
      }));
      entry.connected = true;
      entry.lastConnectedAt = new Date().toISOString();
      entry.retryCount = 0;
      this.clients.set(serverId, entry);
      this.ensureHealthCheck();
      this.logger.info(`MCP server "${server.name}" connected (${entry.tools.length} tools)`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      entry.error = msg;
      this.clients.set(serverId, entry);
      this.logger.error(`MCP server "${server.name}" connection failed: ${msg}`);
      this.scheduleRetry(serverId);
    }
  }

  private scheduleRetry(serverId: number) {
    const entry = this.clients.get(serverId);
    if (!entry) return;

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
      this.connect(serverId).catch((err) => {
        this.logger.error(err, `MCP retry failed for server ${serverId}`);
      });
    }, delay);
  }

  async disconnect(serverId: number) {
    const entry = this.clients.get(serverId);
    if (!entry) return;

    if (entry.retryTimeout) clearTimeout(entry.retryTimeout);

    try {
      await entry.client.close();
    } catch {
      // ignore close errors
    }

    this.clients.delete(serverId);
  }

  async destroyAll() {
    if (this.healthCheckInterval) {
      clearInterval(this.healthCheckInterval);
      this.healthCheckInterval = null;
    }

    const ids = [...this.clients.keys()];
    await Promise.all(ids.map((id) => this.disconnect(id)));
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
        });
      }
    }

    return result;
  }

  async callTool(serverId: number, toolName: string, args: unknown): Promise<unknown> {
    const entry = this.clients.get(serverId);
    if (!entry?.connected) {
      throw new Error(`MCP server ${serverId} is not connected`);
    }

    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const result = await Promise.race([
        entry.client.callTool({
          name: toolName,
          arguments: args as Record<string, unknown>,
        }),
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error("MCP tool call timed out")),
            CALL_TOOL_TIMEOUT_MS,
          );
        }),
      ]);

      // Extract text content from MCP response
      if (result.content && Array.isArray(result.content)) {
        const textParts = result.content
          .filter((c): c is { type: "text"; text: string } => c.type === "text")
          .map((c) => c.text);
        if (textParts.length === 1) return textParts[0];
        if (textParts.length > 1) return textParts.join("\n");
      }

      return result.content;
    } finally {
      clearTimeout(timer);
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
      .filter(([, entry]) => entry.connected)
      .map(async ([serverId, entry]) => {
        try {
          const result = await entry.client.listTools();
          entry.tools = (result.tools ?? []).map((t) => ({
            name: t.name,
            description: t.description ?? "",
            inputSchema: (t.inputSchema ?? {}) as Record<string, unknown>,
          }));
        } catch {
          entry.connected = false;
          entry.error = "Health check failed";
          entry.retryCount = 0;
          this.logger.warn(`MCP server ${serverId} health check failed, reconnecting...`);
          this.scheduleRetry(serverId);
        }
      });
    await Promise.allSettled(checks);
  }
}
