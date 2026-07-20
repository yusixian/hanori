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
});
