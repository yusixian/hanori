import type { Database } from "@cos-tool-bot/database";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import type { Logger } from "pino";
import { afterEach, describe, expect, it, vi } from "vitest";
import { isAdminOnlyMcpServer, McpClientManager } from "./mcp-client-manager.js";

describe("isAdminOnlyMcpServer", () => {
  it.each([
    [null, "https://github.com/mcp"],
    [null, "https://api.github.com/mcp"],
    [null, "https://API.GITHUB.COM/mcp"],
    [null, "https://githubcopilot.com/mcp"],
    [null, "https://api.githubcopilot.com/mcp"],
    ["github", "https://example.com/mcp"],
    ["github", "not a url"],
  ])("keeps presetId %s at %s for admins", (presetId, url) => {
    expect(isAdminOnlyMcpServer({ presetId, url })).toBe(true);
  });

  it.each([
    [null, "https://github.com.evil.example/mcp"],
    [null, "https://evil-github.com/mcp"],
    [null, "https://notgithub.com/mcp"],
    [null, "not a url"],
    ["other", "https://example.com/mcp"],
  ])("offers presetId %s at %s to everyone", (presetId, url) => {
    expect(isAdminOnlyMcpServer({ presetId, url })).toBe(false);
  });
});

describe("MCP tool execution", () => {
  let manager: McpClientManager | undefined;
  let server: Server | undefined;

  afterEach(async () => {
    await manager?.destroyAll();
    await server?.close();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  async function connectTool(
    durationMs: number,
    content = [{ type: "text", text: "done" }],
    ignoreCancellation = false,
  ) {
    vi.useFakeTimers();
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    server = new Server({ name: "slow-tools", version: "1.0.0" }, { capabilities: { tools: {} } });
    server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: [{ name: "slow", inputSchema: { type: "object" } }],
    }));
    let remoteSignal: AbortSignal | undefined;
    const effects = vi.fn();
    server.setRequestHandler(CallToolRequestSchema, async (_request, { signal }) => {
      remoteSignal = signal;
      effects();
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => resolve({ content }), durationMs);
        signal.addEventListener(
          "abort",
          () => {
            if (ignoreCancellation) return;
            clearTimeout(timer);
            reject(signal.reason);
          },
          { once: true },
        );
      });
    });
    await server.connect(serverTransport);

    const connect = Client.prototype.connect;
    vi.spyOn(Client.prototype, "connect").mockImplementation(
      function (this: Client, transport, options) {
        void transport;
        return connect.call(this, clientTransport, options);
      },
    );
    const callTool = vi.spyOn(Client.prototype, "callTool");
    const db = {
      select: () => ({
        from: () => ({
          where: async () => [
            {
              id: 1,
              name: "Slow tools",
              isActive: true,
              url: "https://example.test/mcp",
              transport: "streamable-http",
              presetId: null,
              toolNamePrefix: null,
              encryptedHeaders: null,
            },
          ],
        }),
      }),
    } as unknown as Database;
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as unknown as Logger;
    manager = new McpClientManager(db, logger, "unused-test-key");
    await manager.connect(1);
    return { manager, callTool, effects, getRemoteSignal: () => remoteSignal };
  }

  it("allows a real SDK request to finish after both the old SDK and host limits", async () => {
    const { manager, callTool } = await connectTool(6 * 60 * 1000);
    const settled = vi.fn();
    const pending = manager.callTool(1, "slow", { query: "long operation" }).then(
      (value) => {
        settled();
        return { value };
      },
      (error: unknown) => {
        settled();
        return { error };
      },
    );

    await vi.advanceTimersByTimeAsync(5 * 60 * 1000 + 1000);
    expect(settled).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(59_000);
    await expect(pending).resolves.toEqual({ value: "done" });
    expect(callTool.mock.calls[0]?.[2]).toMatchObject({
      timeout: 10 * 60 * 1000,
      maxTotalTimeout: 10 * 60 * 1000,
    });
  });

  it("reports an unknown outcome and cancels the underlying SDK request on timeout", async () => {
    const { manager, callTool, getRemoteSignal } = await connectTool(11 * 60 * 1000);
    const pending = manager.callTool(1, "slow", {}).catch((error: unknown) => error);

    await vi.advanceTimersByTimeAsync(10 * 60 * 1000);

    await expect(pending).resolves.toMatchObject({
      outcome: "unknown",
      requestId: expect.any(String),
    });
    expect(callTool.mock.calls[0]?.[2]?.signal?.aborted).toBe(true);
    expect(getRemoteSignal()?.aborted).toBe(true);
  });

  it("cancels the remote request when the caller aborts", async () => {
    const { manager, getRemoteSignal } = await connectTool(6 * 60 * 1000);
    const controller = new AbortController();
    const reason = new Error("chat cancelled");
    const pending = manager
      .callTool(1, "slow", {}, controller.signal)
      .catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(1000);

    controller.abort(reason);
    await vi.advanceTimersByTimeAsync(0);

    await expect(pending).resolves.toMatchObject({ outcome: "unknown" });
    expect(getRemoteSignal()?.aborted).toBe(true);
  });

  it("does not submit a request for an already aborted caller", async () => {
    const { manager, callTool } = await connectTool(1000);
    const reason = new Error("already cancelled");

    await expect(manager.callTool(1, "slow", {}, AbortSignal.abort(reason))).rejects.toMatchObject({
      outcome: "cancelled",
    });
    expect(callTool).not.toHaveBeenCalled();
  });

  it("does not cancel another request on the shared connection", async () => {
    const { manager, effects } = await connectTool(1000);
    const controller = new AbortController();
    const first = manager
      .callTool(1, "slow", {}, controller.signal)
      .catch((error: unknown) => error);
    const second = manager.callTool(1, "slow", {});
    await vi.advanceTimersByTimeAsync(100);
    controller.abort();
    await vi.advanceTimersByTimeAsync(900);
    await expect(first).resolves.toMatchObject({ outcome: "unknown" });
    await expect(second).resolves.toBe("done");
    expect(effects).toHaveBeenCalledTimes(2);
    expect(manager.getStatus(1)[0]?.connected).toBe(true);
  });

  it("keeps a lost write receipt unknown even if the remote ignores cancellation and finishes", async () => {
    const { manager, effects } = await connectTool(11 * 60 * 1000, undefined, true);
    const settled = vi.fn();
    const pending = manager.callTool(1, "slow", {}).catch((error: unknown) => {
      settled();
      return error;
    });
    await vi.advanceTimersByTimeAsync(10 * 60 * 1000);
    await expect(pending).resolves.toMatchObject({ outcome: "unknown" });
    await vi.advanceTimersByTimeAsync(60 * 1000);
    expect(effects).toHaveBeenCalledOnce();
    expect(settled).toHaveBeenCalledOnce();
  });

  it("classifies explicit remote errors separately from lost receipts", async () => {
    const { manager, callTool } = await connectTool(1000);
    callTool.mockResolvedValueOnce({
      isError: true,
      content: [{ type: "text", text: "Missing field title; Authorization: Bearer private-token" }],
    });
    const failure = await manager.callTool(1, "slow", {}).catch((error: unknown) => error);
    expect(failure).toMatchObject({ outcome: "failed" });
    expect((failure as Error).message).toContain("Missing field title");
    expect((failure as Error).message).not.toContain("private-token");
  });

  it("preserves extraction of multiple text results", async () => {
    const { manager } = await connectTool(1000, [
      { type: "text", text: "first" },
      { type: "text", text: "second" },
    ]);
    const pending = manager.callTool(1, "slow", {});

    await vi.advanceTimersByTimeAsync(1000);

    await expect(pending).resolves.toBe("first\nsecond");
  });
});
