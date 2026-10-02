import { RUNTIME_DIAGNOSTIC_OPERATIONS } from "@cos-tool-bot/shared";
import type { RuntimeDiagnosticsPort, RuntimeDiagnosticActor } from "@cos-tool-bot/shared";
import type { Tool } from "ai";
import { tool } from "ai";
import { z } from "zod";
import { zodToAiSchema } from "./utils.js";

const DESCRIPTIONS = {
  get_runtime_status:
    "管理员只读诊断：查看当前 Bot 的运行状态、依赖可达性与当前聊天执行队列。未知健康状态会明确标记。",
  get_effective_config:
    "管理员只读诊断：查看当前聊天实际使用的模型、超时、回复模式、功能开关与本轮可用工具，不包含凭据或提示词。",
  get_request_trace:
    "管理员只读诊断：查看当前聊天上一条用户消息的处理链路，定位入站等待、模型超时、工具失败或 Telegram 投递失败。默认排除当前诊断请求；可按 traceId 或 messageId 查询。",
  query_sanitized_logs:
    "管理员只读诊断：按时间窗口和分页查询当前聊天的安全结构化诊断事件。可按 traceId、messageId 或 toolCallId 过滤，不返回原始消息或日志。",
  get_recent_errors:
    "管理员只读诊断：查询当前聊天近期的结构化失败与超时事件，可按时间窗口和分页缩小范围。",
} as const;

const FILTER_FIELDS = {
  messageId: z
    .number()
    .int()
    .positive()
    .nullable()
    .optional()
    .describe("真实消息记录中的 messageId；不要猜测。省略或 null 表示不按消息过滤。"),
  toolCallId: z
    .string()
    .min(1)
    .max(100)
    .nullable()
    .optional()
    .describe("真实诊断记录中的工具调用 ID；不要猜测。省略或 null 表示不按工具调用过滤。"),
  traceId: z
    .string()
    .min(1)
    .max(100)
    .nullable()
    .optional()
    .describe("真实诊断记录中的 traceId；不要猜测。省略或 null 使用默认查询范围。"),
  windowMs: z
    .number()
    .int()
    .min(1)
    .max(86_400_000)
    .nullable()
    .optional()
    .describe("回看时间窗口，单位毫秒，最多 24 小时；省略或 null 使用服务端保留窗口。"),
  limit: z
    .number()
    .int()
    .min(1)
    .max(50)
    .nullable()
    .optional()
    .describe("每页最多返回数量，1 到 50；省略或 null 使用服务端默认值。"),
  offset: z
    .number()
    .int()
    .min(0)
    .max(500)
    .nullable()
    .optional()
    .describe("分页跳过数量，0 到 500；省略或 null 从第一页开始。"),
};
const previous = z
  .boolean()
  .nullable()
  .optional()
  .describe(
    "查询当前诊断请求之前的用户消息，默认 true。省略或 null 使用默认值；指定真实 traceId/messageId 时优先定位该记录。",
  );
const EMPTY_SCHEMA = z.object({}).strict();
const TRACE_SCHEMA = z.object({ ...FILTER_FIELDS, previous }).strict();
const LOG_SCHEMA = z.object(FILTER_FIELDS).strict();

function normalizeRequest(request: Record<string, unknown> | null): Record<string, unknown> {
  const normalized = { ...request };
  for (const name of [...Object.keys(FILTER_FIELDS), "previous"]) {
    const value = normalized[name];
    if (
      value === null ||
      ((name === "traceId" || name === "toolCallId") && typeof value === "string" && !value.trim())
    ) {
      delete normalized[name];
    }
  }
  return normalized;
}

export function createRuntimeDiagnosticTools(options: {
  port: RuntimeDiagnosticsPort;
  actor: RuntimeDiagnosticActor;
  adminIds: readonly number[];
}): Record<string, Tool> {
  if (!options.adminIds.includes(options.actor.userId)) return {};
  return Object.fromEntries(
    RUNTIME_DIAGNOSTIC_OPERATIONS.map((operation) => [
      operation,
      tool({
        description: DESCRIPTIONS[operation],
        inputSchema: zodToAiSchema(
          operation === "get_runtime_status" || operation === "get_effective_config"
            ? EMPTY_SCHEMA
            : operation === "get_request_trace"
              ? TRACE_SCHEMA
              : LOG_SCHEMA,
        ),
        execute: async (request) =>
          options.port.query(options.actor, { ...normalizeRequest(request), operation }),
      }),
    ]),
  );
}
