import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import {
  UnauthorizedError,
  type OAuthClientProvider,
} from "@modelcontextprotocol/sdk/client/auth.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { CallToolResultSchema, type CallToolResult } from "@modelcontextprotocol/sdk/types.js";

import type { PixaiMcpAuthSession } from "./pixai-mcp-oauth-provider.js";

export const PIXAI_MCP_TOOL_NAMES = [
  "get_capabilities",
  "list_models",
  "prepare_generation",
  "generate",
  "get_task",
  "get_generation_details",
  "list_tasks",
  "wait_for_result",
  "get_result",
  "cancel_task",
] as const;

export type PixaiMcpToolName = (typeof PIXAI_MCP_TOOL_NAMES)[number];

export interface PixaiMcpInlineImage {
  type: "image";
  data: string;
  mimeType: string;
}

export interface PixaiMcpResourceLink {
  type: "resource_link";
  uri: string;
  name: string;
  description?: string;
  mimeType?: string;
}

export interface PixaiMcpToolResponse<T = unknown> {
  result: T;
  structuredContent?: Record<string, unknown>;
  text: string[];
  images: PixaiMcpInlineImage[];
  resourceLinks: PixaiMcpResourceLink[];
}

export type PixaiMcpClientErrorCode =
  | "NOT_CONFIGURED"
  | "AUTHORIZATION_REQUIRED"
  | "CONNECTION_FAILED"
  | "NOT_CONNECTED"
  | "TOOL_CALL_FAILED"
  | "TOOL_RESULT_INVALID"
  | "OAUTH_CALLBACK_FAILED";

export class PixaiMcpClientError extends Error {
  constructor(readonly code: PixaiMcpClientErrorCode) {
    super(messageForCode(code));
    this.name = "PixaiMcpClientError";
  }
}

interface McpClientLike {
  connect(transport: StreamableHTTPClientTransport): Promise<void>;
  close(): Promise<void>;
  callTool(
    params: { name: string; arguments?: Record<string, unknown> },
    resultSchema?: undefined,
    options?: { signal?: AbortSignal; timeout?: number; maxTotalTimeout?: number },
  ): Promise<unknown>;
}

interface PixaiMcpConnection {
  client: McpClientLike;
  transport: StreamableHTTPClientTransport;
}

interface ActiveConnection extends PixaiMcpConnection {
  authSession: PixaiMcpAuthSession;
  connected: boolean;
  pending?: Promise<void>;
}

export interface PixaiMcpClientOptions {
  createAuthSession: () => PixaiMcpAuthSession;
  environment?: "production" | "non-production";
  endpointOverride?: string | URL;
  fetch?: typeof fetch;
  callTimeoutMs?: number;
  onCallError?: (failure: {
    toolName: PixaiMcpToolName;
    code: PixaiMcpClientErrorCode;
    isCurrent: () => boolean;
  }) => void | Promise<void>;
  connectionFactory?: (
    endpoint: URL,
    authProvider: OAuthClientProvider,
    fetchFn: typeof fetch | undefined,
  ) => PixaiMcpConnection;
}

export function resolvePixaiMcpEndpoint(input: {
  environment: "production" | "non-production";
  endpointOverride?: string | URL;
}): URL | undefined {
  const value = input.endpointOverride?.toString().trim();
  if (!value) return undefined;
  let endpoint: URL;
  try {
    endpoint = new URL(value);
  } catch {
    throw new Error("PIXAI_MCP_URL must be an HTTPS URL without credentials, query or fragment");
  }
  const localDevelopment =
    input.environment === "non-production" &&
    endpoint.protocol === "http:" &&
    ["localhost", "127.0.0.1", "[::1]"].includes(endpoint.hostname);
  if (
    (endpoint.protocol !== "https:" && !localDevelopment) ||
    endpoint.username ||
    endpoint.password ||
    endpoint.search ||
    endpoint.hash
  ) {
    throw new Error("PIXAI_MCP_URL must be an HTTPS URL without credentials, query or fragment");
  }
  return endpoint;
}

export class PixaiMcpClient {
  readonly endpoint: URL | undefined;

  private readonly callTimeoutMs: number;
  private readonly connectionFactory: NonNullable<PixaiMcpClientOptions["connectionFactory"]>;
  private readonly createAuthSession: () => PixaiMcpAuthSession;
  private readonly fetchFn?: typeof fetch;
  private readonly onCallError?: PixaiMcpClientOptions["onCallError"];
  private connection: ActiveConnection | undefined;
  private generation = 0;

  constructor(options: PixaiMcpClientOptions) {
    this.endpoint = resolvePixaiMcpEndpoint({
      environment: options.environment ?? "production",
      endpointOverride: options.endpointOverride,
    });
    this.callTimeoutMs = options.callTimeoutMs ?? 5 * 60 * 1000;
    this.connectionFactory = options.connectionFactory ?? createConnection;
    this.createAuthSession = options.createAuthSession;
    this.fetchFn = options.fetch;
    this.onCallError = options.onCallError;
    this.connection = this.createConnection();
  }

  async connect(): Promise<void> {
    const connection = this.connection ?? (this.connection = this.createConnection());
    if (!connection) throw new PixaiMcpClientError("NOT_CONFIGURED");
    if (connection.connected) return;
    if (connection.pending) return connection.pending;
    const pending = (async () => {
      try {
        await connection.client.connect(connection.transport);
        if (this.connection !== connection) throw new PixaiMcpClientError("NOT_CONNECTED");
        connection.connected = true;
      } catch (error) {
        throw new PixaiMcpClientError(
          isUnauthorizedError(error) ? "AUTHORIZATION_REQUIRED" : "CONNECTION_FAILED",
        );
      }
    })();
    connection.pending = pending;
    try {
      await pending;
    } finally {
      if (connection.pending === pending) connection.pending = undefined;
    }
  }

  async finishAuthorization(authorizationCode: string): Promise<void> {
    const connection = this.connection;
    if (!connection)
      throw new PixaiMcpClientError(this.endpoint ? "NOT_CONNECTED" : "NOT_CONFIGURED");
    try {
      await connection.transport.finishAuth(authorizationCode);
      if (this.connection !== connection) throw new PixaiMcpClientError("NOT_CONNECTED");
      try {
        await connection.client.close();
      } catch {
        // The unauthorized handshake may already have closed this client.
      }
      if (this.connection !== connection) throw new PixaiMcpClientError("NOT_CONNECTED");
      // Callback exchange and the replacement SDK transport share one revocable grant.
      const replacement = this.createConnection(connection.authSession)!;
      this.connection = replacement;
      await this.connect();
    } catch {
      throw new PixaiMcpClientError("OAUTH_CALLBACK_FAILED");
    }
  }

  async close(): Promise<void> {
    const connection = this.connection;
    this.generation++;
    this.connection = undefined;
    if (!connection) return;
    const drained = connection.authSession.revokeAndDrain();
    await Promise.all([
      drained,
      connection.client.close().catch(() => {
        // Closing is best-effort and must not expose transport details.
      }),
    ]);
  }

  private createConnection(authSession?: PixaiMcpAuthSession): ActiveConnection | undefined {
    if (!this.endpoint) return undefined;
    const session = authSession ?? this.createAuthSession();
    return {
      ...this.connectionFactory(this.endpoint, session.provider, this.fetchFn),
      authSession: session,
      connected: false,
    };
  }

  getCapabilities<T = unknown>(signal?: AbortSignal): Promise<PixaiMcpToolResponse<T>> {
    return this.call<T>("get_capabilities", {}, signal);
  }

  listModels<T = unknown>(signal?: AbortSignal): Promise<PixaiMcpToolResponse<T>> {
    return this.call<T>("list_models", {}, signal);
  }

  prepareGeneration<T = unknown>(
    input: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<PixaiMcpToolResponse<T>> {
    return this.call<T>("prepare_generation", input, signal);
  }

  generate<T = unknown>(
    input: { planId: string; idempotencyKey: string },
    signal?: AbortSignal,
  ): Promise<PixaiMcpToolResponse<T>> {
    return this.call<T>("generate", input, signal);
  }

  getTask<T = unknown>(
    operationId: string,
    signal?: AbortSignal,
  ): Promise<PixaiMcpToolResponse<T>> {
    return this.call<T>("get_task", { operationId }, signal);
  }

  getGenerationDetails<T = unknown>(
    operationId: string,
    signal?: AbortSignal,
  ): Promise<PixaiMcpToolResponse<T>> {
    return this.call<T>("get_generation_details", { operationId }, signal);
  }

  listTasks<T = unknown>(limit = 20, signal?: AbortSignal): Promise<PixaiMcpToolResponse<T>> {
    return this.call<T>("list_tasks", { limit }, signal);
  }

  waitForResult<T = unknown>(
    operationId: string,
    timeoutMs = 5_000,
    signal?: AbortSignal,
  ): Promise<PixaiMcpToolResponse<T>> {
    return this.call<T>("wait_for_result", { operationId, timeoutMs }, signal, timeoutMs + 5_000);
  }

  getResult<T = unknown>(
    operationId: string,
    signal?: AbortSignal,
  ): Promise<PixaiMcpToolResponse<T>> {
    return this.call<T>("get_result", { operationId }, signal);
  }

  cancelTask<T = unknown>(
    operationId: string,
    signal?: AbortSignal,
  ): Promise<PixaiMcpToolResponse<T>> {
    return this.call<T>("cancel_task", { operationId }, signal);
  }

  private async call<T>(
    name: PixaiMcpToolName,
    args: Record<string, unknown>,
    signal?: AbortSignal,
    timeoutMs = this.callTimeoutMs,
  ): Promise<PixaiMcpToolResponse<T>> {
    const connection = this.connection;
    if (!connection?.connected) {
      const error = new PixaiMcpClientError(this.endpoint ? "NOT_CONNECTED" : "NOT_CONFIGURED");
      await this.notifyCallError(name, error.code, connection);
      throw error;
    }
    try {
      const rawValue = await connection.client.callTool({ name, arguments: args }, undefined, {
        signal,
        timeout: timeoutMs,
        maxTotalTimeout: timeoutMs,
      });
      if (this.connection !== connection) throw new PixaiMcpClientError("NOT_CONNECTED");
      const parsed = CallToolResultSchema.safeParse(rawValue);
      if (!parsed.success) throw new PixaiMcpClientError("TOOL_RESULT_INVALID");
      const raw = parsed.data;
      if (raw.isError) throw new PixaiMcpClientError("TOOL_CALL_FAILED");
      return normalizePixaiMcpToolResponse<T>(raw);
    } catch (error) {
      const mapped =
        error instanceof PixaiMcpClientError
          ? error
          : new PixaiMcpClientError(
              isUnauthorizedError(error) ? "AUTHORIZATION_REQUIRED" : "TOOL_CALL_FAILED",
            );
      if (this.connection === connection && mapped.code === "AUTHORIZATION_REQUIRED")
        connection.connected = false;
      await this.notifyCallError(name, mapped.code, connection);
      throw mapped;
    }
  }

  private async notifyCallError(
    toolName: PixaiMcpToolName,
    code: PixaiMcpClientErrorCode,
    connection: ActiveConnection | undefined,
  ): Promise<void> {
    const generation = this.generation;
    const isCurrent = () => this.connection === connection && this.generation === generation;
    if (!isCurrent()) return;
    try {
      await this.onCallError?.({ toolName, code, isCurrent });
    } catch {
      // Connection diagnostics must never replace the sanitized MCP failure.
    }
  }
}

export function normalizePixaiMcpToolResponse<T = unknown>(
  raw: CallToolResult,
): PixaiMcpToolResponse<T> {
  const text: string[] = [];
  const images: PixaiMcpInlineImage[] = [];
  const resourceLinks: PixaiMcpResourceLink[] = [];

  for (const content of raw.content) {
    if (content.type === "text") text.push(content.text);
    if (content.type === "image") {
      images.push({ type: "image", data: content.data, mimeType: content.mimeType });
    }
    if (content.type === "resource_link") {
      resourceLinks.push({
        type: "resource_link",
        uri: content.uri,
        name: content.name,
        description: content.description,
        mimeType: content.mimeType,
      });
    }
  }

  const structuredContent = raw.structuredContent;
  let result = structuredContent?.["result"];
  if (result === undefined && text.length > 0) {
    result = parseTextResult(text[0]!);
  }
  if (result === undefined) throw new PixaiMcpClientError("TOOL_RESULT_INVALID");

  return { result: result as T, structuredContent, text, images, resourceLinks };
}

function parseTextResult(value: string): unknown {
  try {
    const parsed: unknown = JSON.parse(value);
    if (isRecord(parsed) && "result" in parsed) return parsed.result;
    return parsed;
  } catch {
    return undefined;
  }
}

function createConnection(
  endpoint: URL,
  authProvider: OAuthClientProvider,
  fetchFn: typeof fetch | undefined,
): PixaiMcpConnection {
  const transport = new StreamableHTTPClientTransport(endpoint, {
    authProvider,
    fetch: fetchFn,
  });
  const client = new Client({ name: "Hanori-pixai", version: "1.0.0" });
  return { client, transport };
}

function isUnauthorizedError(error: unknown): boolean {
  return error instanceof UnauthorizedError;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function messageForCode(code: PixaiMcpClientErrorCode): string {
  switch (code) {
    case "NOT_CONFIGURED":
      return "Set PIXAI_MCP_URL before connecting the image MCP service";
    case "AUTHORIZATION_REQUIRED":
      return "PixAI MCP owner authorization is required";
    case "CONNECTION_FAILED":
      return "PixAI MCP connection failed";
    case "NOT_CONNECTED":
      return "PixAI MCP client is not connected";
    case "TOOL_CALL_FAILED":
      return "PixAI MCP tool call failed";
    case "TOOL_RESULT_INVALID":
      return "PixAI MCP returned an invalid tool result";
    case "OAUTH_CALLBACK_FAILED":
      return "PixAI MCP authorization callback failed";
  }
}
