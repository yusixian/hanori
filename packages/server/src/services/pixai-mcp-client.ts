import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import {
  UnauthorizedError,
  type OAuthClientProvider,
} from "@modelcontextprotocol/sdk/client/auth.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { CallToolResultSchema, type CallToolResult } from "@modelcontextprotocol/sdk/types.js";

export const PIXAI_MCP_PRODUCTION_ENDPOINT = "https://mcp.aistine.com/mcp/pixai";
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

export interface PixaiMcpClientOptions {
  authProvider: OAuthClientProvider;
  environment?: "production" | "non-production";
  endpointOverride?: string | URL;
  fetch?: typeof fetch;
  callTimeoutMs?: number;
  onCallError?: (failure: {
    toolName: PixaiMcpToolName;
    code: PixaiMcpClientErrorCode;
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
}): URL {
  if (input.environment === "production" || input.endpointOverride === undefined) {
    return new URL(PIXAI_MCP_PRODUCTION_ENDPOINT);
  }
  return new URL(input.endpointOverride);
}

export class PixaiMcpClient {
  readonly endpoint: URL;

  private readonly callTimeoutMs: number;
  private readonly connectionFactory: NonNullable<PixaiMcpClientOptions["connectionFactory"]>;
  private readonly authProvider: OAuthClientProvider;
  private readonly fetchFn?: typeof fetch;
  private readonly onCallError?: PixaiMcpClientOptions["onCallError"];
  private connection: PixaiMcpConnection;
  private connected = false;

  constructor(options: PixaiMcpClientOptions) {
    this.endpoint = resolvePixaiMcpEndpoint({
      environment: options.environment ?? "production",
      endpointOverride: options.endpointOverride,
    });
    this.callTimeoutMs = options.callTimeoutMs ?? 5 * 60 * 1000;
    this.connectionFactory = options.connectionFactory ?? createConnection;
    this.authProvider = options.authProvider;
    this.fetchFn = options.fetch;
    this.onCallError = options.onCallError;
    this.connection = this.createConnection();
  }

  async connect(): Promise<void> {
    if (this.connected) return;
    try {
      await this.connection.client.connect(this.connection.transport);
      this.connected = true;
    } catch (error) {
      throw new PixaiMcpClientError(
        isUnauthorizedError(error) ? "AUTHORIZATION_REQUIRED" : "CONNECTION_FAILED",
      );
    }
  }

  async finishAuthorization(authorizationCode: string): Promise<void> {
    try {
      await this.connection.transport.finishAuth(authorizationCode);
      try {
        await this.connection.client.close();
      } catch {
        // The unauthorized handshake may already have closed this client.
      }
      this.connection = this.createConnection();
      await this.connection.client.connect(this.connection.transport);
      this.connected = true;
    } catch {
      throw new PixaiMcpClientError("OAUTH_CALLBACK_FAILED");
    }
  }

  async close(): Promise<void> {
    this.connected = false;
    try {
      await this.connection.client.close();
    } catch {
      // Closing is best-effort and must not expose transport details.
    } finally {
      // MCP SDK Client/transport instances are single-session objects. OAuth reconnects
      // start from a fresh pair while preserving the durable provider state.
      this.connection = this.createConnection();
    }
  }

  private createConnection(): PixaiMcpConnection {
    return this.connectionFactory(this.endpoint, this.authProvider, this.fetchFn);
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
    if (!this.connected) {
      const error = new PixaiMcpClientError("NOT_CONNECTED");
      await this.notifyCallError(name, error.code);
      throw error;
    }
    try {
      const rawValue = await this.connection.client.callTool({ name, arguments: args }, undefined, {
        signal,
        timeout: timeoutMs,
        maxTotalTimeout: timeoutMs,
      });
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
      if (mapped.code === "AUTHORIZATION_REQUIRED") this.connected = false;
      await this.notifyCallError(name, mapped.code);
      throw mapped;
    }
  }

  private async notifyCallError(
    toolName: PixaiMcpToolName,
    code: PixaiMcpClientErrorCode,
  ): Promise<void> {
    try {
      await this.onCallError?.({ toolName, code });
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
