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
          z
            .object({
              messageId: z.number().int().positive().optional(),
              toolCallId: z.string().max(100).optional(),
              traceId: z.string().max(100).optional(),
              previous: z.boolean().optional(),
              windowMs: z.number().int().min(1).max(86_400_000).optional(),
              limit: z.number().int().min(1).max(50).optional(),
              offset: z.number().int().min(0).max(500).optional(),
            })
            .strict(),
        ),
        execute: async (request) => options.port.query(options.actor, { ...request, operation }),
      }),
    ]),
  );
}
