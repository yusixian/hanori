import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import {
  UnauthorizedError,
  type OAuthClientProvider,
} from "@modelcontextprotocol/sdk/client/auth.js";
import { describe, expect, it, vi } from "vitest";
import {
  PIXAI_MCP_PRODUCTION_ENDPOINT,
  PixaiMcpClient,
  PixaiMcpClientError,
  normalizePixaiMcpToolResponse,
  resolvePixaiMcpEndpoint,
} from "./pixai-mcp-client.js";

const authProvider = {
  redirectUrl: new URL("https://bot.example/callback"),
  clientMetadata: { redirect_uris: ["https://bot.example/callback"] },
  clientInformation: async () => undefined,
  tokens: async () => undefined,
  saveTokens: async () => {},
  redirectToAuthorization: async () => {},
  saveCodeVerifier: async () => {},
  codeVerifier: async () => "verifier",
};

describe("PixaiMcpClient", () => {
  it("pins production and permits only a constructor override outside production", () => {
    expect(
      resolvePixaiMcpEndpoint({
        environment: "production",
        endpointOverride: "http://127.0.0.1:9999/mcp/pixai",
      }).toString(),
    ).toBe(PIXAI_MCP_PRODUCTION_ENDPOINT);
    expect(
      resolvePixaiMcpEndpoint({
        environment: "non-production",
        endpointOverride: "http://127.0.0.1:9999/mcp/pixai",
      }).toString(),
    ).toBe("http://127.0.0.1:9999/mcp/pixai");
  });

  it("retains structured output, images, and protected resource links", () => {
    const response = normalizePixaiMcpToolResponse({
      structuredContent: { result: { operationId: "operation-1", complete: true } },
      content: [
        { type: "text", text: "summary" },
        { type: "image", data: "aGVsbG8=", mimeType: "image/webp" },
        {
          type: "resource_link",
          uri: "https://mcp.aistine.com/api/artifacts/11111111-1111-4111-8111-111111111111",
          name: "result",
          mimeType: "image/webp",
        },
      ],
    });

    expect(response.result).toEqual({ operationId: "operation-1", complete: true });
    expect(response.images).toHaveLength(1);
    expect(response.resourceLinks).toHaveLength(1);
  });

  it("uses the exact tool contract and sanitizes upstream failures", async () => {
    const callTool = vi.fn().mockRejectedValue(new Error("access-secret prompt-secret"));
    const sdkClient = {
      connect: vi.fn().mockResolvedValue(undefined),
      close: vi.fn().mockResolvedValue(undefined),
      callTool,
    };
    const client = new PixaiMcpClient({
      authProvider,
      connectionFactory: (endpoint, provider) => ({
        client: sdkClient,
        transport: new StreamableHTTPClientTransport(endpoint, { authProvider: provider }),
      }),
    });
    await client.connect();

    await expect(client.getTask("operation-1")).rejects.toEqual(
      new PixaiMcpClientError("TOOL_CALL_FAILED"),
    );
    await expect(client.getTask("operation-1")).rejects.not.toThrow(/secret/);
    expect(callTool).toHaveBeenCalledWith(
      { name: "get_task", arguments: { operationId: "operation-1" } },
      undefined,
      expect.objectContaining({ timeout: 30_000, maxTotalTimeout: 30_000 }),
    );
  });

  it("creates a fresh SDK session before reconnecting after close", async () => {
    const first = {
      connect: vi.fn().mockResolvedValue(undefined),
      close: vi.fn().mockResolvedValue(undefined),
      callTool: vi.fn(),
    };
    const second = {
      connect: vi.fn().mockResolvedValue(undefined),
      close: vi.fn().mockResolvedValue(undefined),
      callTool: vi.fn(),
    };
    const clients = [first, second];
    const connectionFactory = vi.fn((endpoint: URL, provider: OAuthClientProvider) => ({
      client: clients.shift()!,
      transport: new StreamableHTTPClientTransport(endpoint, { authProvider: provider }),
    }));
    const client = new PixaiMcpClient({ authProvider, connectionFactory });

    await client.connect();
    await client.close();
    await client.connect();

    expect(connectionFactory).toHaveBeenCalledTimes(2);
    expect(first.connect).toHaveBeenCalledOnce();
    expect(first.close).toHaveBeenCalledOnce();
    expect(second.connect).toHaveBeenCalledOnce();
  });

  it("classifies the SDK authorization redirect as authorization required", async () => {
    const sdkClient = {
      connect: vi.fn().mockRejectedValue(new UnauthorizedError()),
      close: vi.fn().mockResolvedValue(undefined),
      callTool: vi.fn(),
    };
    const client = new PixaiMcpClient({
      authProvider,
      connectionFactory: (endpoint, provider) => ({
        client: sdkClient,
        transport: new StreamableHTTPClientTransport(endpoint, { authProvider: provider }),
      }),
    });

    await expect(client.connect()).rejects.toEqual(
      new PixaiMcpClientError("AUTHORIZATION_REQUIRED"),
    );
  });

  it("marks an unauthorized tool call as disconnected and reports only its sanitized code", async () => {
    const onCallError = vi.fn();
    const callTool = vi.fn().mockRejectedValue(new UnauthorizedError());
    const sdkClient = {
      connect: vi.fn().mockResolvedValue(undefined),
      close: vi.fn().mockResolvedValue(undefined),
      callTool,
    };
    const client = new PixaiMcpClient({
      authProvider,
      onCallError,
      connectionFactory: (endpoint, provider) => ({
        client: sdkClient,
        transport: new StreamableHTTPClientTransport(endpoint, { authProvider: provider }),
      }),
    });
    await client.connect();

    await expect(client.getCapabilities()).rejects.toEqual(
      new PixaiMcpClientError("AUTHORIZATION_REQUIRED"),
    );
    await expect(client.getCapabilities()).rejects.toEqual(
      new PixaiMcpClientError("NOT_CONNECTED"),
    );
    expect(callTool).toHaveBeenCalledOnce();
    expect(onCallError).toHaveBeenNthCalledWith(1, {
      toolName: "get_capabilities",
      code: "AUTHORIZATION_REQUIRED",
    });
    expect(onCallError).toHaveBeenNthCalledWith(2, {
      toolName: "get_capabilities",
      code: "NOT_CONNECTED",
    });
  });
});
