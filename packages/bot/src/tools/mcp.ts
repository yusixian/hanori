import { McpToolCallError } from "@cos-tool-bot/shared";
import { createOnceGuard, type OnceGuardContext } from "./utils.js";
import type { JSONValue, Tool } from "ai";
import { jsonSchema, tool } from "ai";

export interface McpToolEntry {
  serverId: number;
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  prefix?: string;
  adminOnly?: boolean;
  readOnlyHint?: boolean;
}

export interface McpToolsOptions {
  getTools: () => McpToolEntry[];
  callTool: (
    serverId: number,
    toolName: string,
    args: unknown,
    signal?: AbortSignal,
  ) => Promise<unknown>;
}

export function createMcpTools(
  options: McpToolsOptions,
  access: { includeAdminTools: boolean } = { includeAdminTools: false },
  guard: OnceGuardContext = createOnceGuard(),
): Record<string, Tool> {
  const result: Record<string, Tool> = {};
  const writes = new Map<number, Promise<unknown>>();
  const unknownRequests = new Map<number, string>();

  for (const t of options.getTools()) {
    if (t.adminOnly && !access.includeAdminTools) continue;
    const prefix = t.prefix || `mcp${t.serverId}`;
    const toolKey = `${prefix}_${t.name}`;

    const schema =
      t.inputSchema && Object.keys(t.inputSchema).length > 0
        ? jsonSchema(t.inputSchema as JSONValue)
        : jsonSchema({ type: "object", properties: {}, additionalProperties: false } as JSONValue);

    result[toolKey] = tool({
      description: t.description || t.name,
      inputSchema: schema,
      execute: async (args, { abortSignal, toolCallId }) => {
        const run = async () => {
          const guardKey = `mcp-unknown:${t.serverId}`;
          if (abortSignal?.aborted) {
            return {
              error: "MCP request cancelled before sending",
              outcome: "cancelled",
              retryable: false,
              toolCallId,
            };
          }
          if (!t.readOnlyHint && guard.hasFired(guardKey)) {
            return {
              error:
                "结果待核对：此 MCP 服务已有结果未知的写操作。请先在远端确认，再由用户明确发起新请求；不要自动重试。",
              outcome: "unknown",
              retryable: false,
              blocked: true,
              requestId: unknownRequests.get(t.serverId),
              serverId: t.serverId,
              toolName: t.name,
              toolCallId,
            };
          }
          try {
            return await options.callTool(t.serverId, t.name, args, abortSignal);
          } catch (err) {
            if (err instanceof McpToolCallError) {
              if (err.outcome === "unknown" && !t.readOnlyHint) {
                guard.markFired(guardKey);
                unknownRequests.set(t.serverId, err.requestId);
              }
              return {
                error:
                  err.outcome === "unknown"
                    ? "结果待核对：请求可能已执行。请先在远端检查实际结果，不要自动重试；取消不代表撤销。"
                    : err.message,
                outcome: err.outcome,
                retryable: false,
                requestId: err.requestId,
                serverId: t.serverId,
                toolName: t.name,
                toolCallId,
              };
            }
            return { error: err instanceof Error ? err.message : String(err) };
          }
        };
        if (t.readOnlyHint) return run();
        // A queued write must observe an earlier unknown result before it can dispatch.
        const pending = (writes.get(t.serverId) ?? Promise.resolve()).then(run, run);
        writes.set(t.serverId, pending);
        return pending;
      },
    });
  }

  return result;
}
