import { McpToolCallError } from "@cos-tool-bot/shared";
import { createOnceGuard } from "./utils.js";
import { describe, expect, it, vi } from "vitest";
import { createMcpTools, type McpToolsOptions } from "./mcp.js";

function options(): McpToolsOptions {
  return {
    getTools: () => [
      {
        serverId: 1,
        name: "search",
        description: "public search",
        inputSchema: { type: "object" },
      },
      {
        serverId: 2,
        name: "create_issue",
        description: "credentialed GitHub mutation",
        inputSchema: { type: "object" },
        adminOnly: true,
      },
    ],
    callTool: vi.fn(),
  };
}

describe("MCP tool access", () => {
  it("omits credentialed GitHub MCP tools for non-admin requests", () => {
    expect(Object.keys(createMcpTools(options()))).toEqual(["mcp1_search"]);
  });

  it("includes credentialed GitHub MCP tools for administrators", () => {
    expect(Object.keys(createMcpTools(options(), { includeAdminTools: true }))).toEqual([
      "mcp1_search",
      "mcp2_create_issue",
    ]);
  });

  it("passes the tool execution signal to the MCP host", async () => {
    const configured = options();
    const tools = createMcpTools(configured);
    const signal = new AbortController().signal;

    await tools.mcp1_search?.execute?.(
      { query: "long operation" },
      { toolCallId: "mcp-call", messages: [], abortSignal: signal },
    );

    expect(configured.callTool).toHaveBeenCalledExactlyOnceWith(
      1,
      "search",
      { query: "long operation" },
      signal,
    );
  });

  it("preserves MCP failures as tool error results", async () => {
    const configured = options();
    configured.callTool = vi.fn(async () => {
      throw new Error("MCP tool call timed out");
    });
    const tools = createMcpTools(configured);

    await expect(
      tools.mcp1_search?.execute?.({}, { toolCallId: "mcp-call", messages: [] }),
    ).resolves.toEqual({ error: "MCP tool call timed out" });
  });
});

describe("MCP uncertain writes", () => {
  it("blocks queued writes after a lost receipt, but allows read-only verification", async () => {
    const configured = options();
    const entries = configured.getTools();
    entries.push({ ...entries[0]!, name: "lookup", readOnlyHint: true });
    configured.getTools = () => entries;
    configured.callTool = vi.fn(async (_server, name) => {
      if (name === "lookup") return "verified";
      throw new McpToolCallError("unknown", "request-1", "connection lost");
    });
    const guard = createOnceGuard();
    const tools = createMcpTools(configured, { includeAdminTools: false }, guard);
    const execute = tools.mcp1_search!.execute!;
    const [first, duplicate] = await Promise.all([
      execute({ value: 1 }, { toolCallId: "first", messages: [] }),
      execute({ value: 2 }, { toolCallId: "second", messages: [] }),
    ]);
    expect(first).toMatchObject({ outcome: "unknown", requestId: "request-1", retryable: false });
    expect(duplicate).toMatchObject({ outcome: "unknown", blocked: true });
    expect(configured.callTool).toHaveBeenCalledOnce();
    await expect(
      tools.mcp1_lookup!.execute!({}, { toolCallId: "verify", messages: [] }),
    ).resolves.toBe("verified");
    const recreated = createMcpTools(configured, { includeAdminTools: false }, guard);
    await expect(
      recreated.mcp1_search!.execute!({}, { toolCallId: "third", messages: [] }),
    ).resolves.toMatchObject({ blocked: true });
    expect(configured.callTool).toHaveBeenCalledTimes(2);
  });

  it("keeps separate turn guards isolated and preserves definite failures", async () => {
    const configured = options();
    configured.callTool = vi.fn(async () => {
      throw new McpToolCallError("failed", "failed-request", "not connected");
    });
    const tools = createMcpTools(configured);
    await expect(
      tools.mcp1_search!.execute!({}, { toolCallId: "first", messages: [] }),
    ).resolves.toMatchObject({ outcome: "failed", error: "not connected" });
    configured.callTool = vi.fn(async () => "reconnected");
    await expect(
      tools.mcp1_search!.execute!({}, { toolCallId: "second", messages: [] }),
    ).resolves.toBe("reconnected");
    const otherTurn = createMcpTools(configured);
    await expect(
      otherTurn.mcp1_search!.execute!({}, { toolCallId: "third", messages: [] }),
    ).resolves.toBe("reconnected");
  });

  it("does not dispatch a queued write when its caller is cancelled", async () => {
    const configured = options();
    const first = deferred<unknown>();
    configured.callTool = vi.fn(() => first.promise);
    const tools = createMcpTools(configured);
    const controller = new AbortController();
    const running = tools.mcp1_search!.execute!({}, { toolCallId: "first", messages: [] });
    const waiting = tools.mcp1_search!.execute!(
      {},
      { toolCallId: "second", messages: [], abortSignal: controller.signal },
    );
    controller.abort();
    first.resolve("done");
    await running;
    await expect(waiting).resolves.toMatchObject({ outcome: "cancelled" });
    expect(configured.callTool).toHaveBeenCalledOnce();
  });
});

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}
