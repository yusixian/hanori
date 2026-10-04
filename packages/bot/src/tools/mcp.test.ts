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
