import type { JSONValue, Tool } from "ai";
import { jsonSchema, tool } from "ai";

export interface McpToolEntry {
  serverId: number;
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  prefix?: string;
}

export interface McpToolsOptions {
  getTools: () => McpToolEntry[];
  callTool: (serverId: number, toolName: string, args: unknown) => Promise<unknown>;
}

export function createMcpTools(options: McpToolsOptions): Record<string, Tool> {
  const result: Record<string, Tool> = {};

  for (const t of options.getTools()) {
    const prefix = t.prefix || `mcp${t.serverId}`;
    const toolKey = `${prefix}_${t.name}`;

    const schema =
      t.inputSchema && Object.keys(t.inputSchema).length > 0
        ? jsonSchema(t.inputSchema as JSONValue)
        : jsonSchema({ type: "object", properties: {}, additionalProperties: false } as JSONValue);

    result[toolKey] = tool({
      description: t.description || t.name,
      inputSchema: schema,
      execute: async (args) => {
        try {
          return await options.callTool(t.serverId, t.name, args);
        } catch (err) {
          return { error: err instanceof Error ? err.message : String(err) };
        }
      },
    });
  }

  return result;
}
