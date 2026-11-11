import { beginTaskDiscussion, endTaskDiscussion } from "../services/task-discussion.js";
import type { ScheduledTaskActor, ScheduledTaskPort } from "@cos-tool-bot/shared";
import { tool } from "ai";
import type { Api } from "grammy";
import { z } from "zod";
import { sendScheduledTaskConfirmation } from "../handlers/scheduled-task-confirmation.js";
import { zodToAiSchema } from "./utils.js";
const time = z.string().describe("带时区偏移的 ISO 日期时间");
const schedule = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("once"), at: time, timezone: z.string() }),
  z.object({
    kind: z.literal("interval"),
    startsAt: time,
    everySeconds: z.number().positive(),
    timezone: z.string(),
  }),
  z.object({
    kind: z.literal("calendar"),
    startsAt: time,
    timezone: z.string(),
    period: z.enum(["week", "month", "quarter"]),
    hour: z.number().int().min(0).max(23),
    minute: z.number().int().min(0).max(59),
    weekday: z.number().int().min(0).max(6).optional(),
    dayOfMonth: z.number().int().min(1).max(31).optional(),
  }),
]);
export function createScheduledTaskTools(options: {
  api: Api;
  port: ScheduledTaskPort;
  getActor: () => ScheduledTaskActor;
}) {
  return {
    begin_task_configuration: tool({
      description:
        "用户提出定时任务但缺少必要时间或任务内容时，先调用此工具，再一次性询问缺少的信息。开启10分钟配置对话，不创建或执行任务。信息充分则直接 propose_scheduled_task。",
      inputSchema: zodToAiSchema(z.object({})),
      execute: async () => {
        beginTaskDiscussion(options.getActor());
        return { status: "configuring", expires_in_seconds: 600 };
      },
    }),
    propose_scheduled_task: tool({
      description:
        "将群友的自然语言需求整理成完整定时计划并发送管理员确认卡。信息充分时直接出卡，避免逐字段盘问。所有人包括管理员均需确认后生效；修改传 task_id 并重新出卡。一个月不是30天，使用 calendar。未配置参数继承当前 Bot 默认任务 Agent；不得编造未读取的历史。",
      inputSchema: zodToAiSchema(
        z.object({
          task_id: z.string().optional(),
          name: z.string().min(1),
          instructions: z.string().min(1),
          dataScope: z.object({
            kind: z.enum(["none", "chat"]),
            lookbackHours: z.number().positive().optional(),
            maxMessages: z.number().int().positive().optional(),
          }),
          agentName: z.string().optional(),
          destination: z.object({ chatId: z.number(), threadId: z.number().optional() }),
          schedule,
          agent: z.object({
            providerId: z.string().optional(),
            modelId: z.string().optional(),
            systemPrompt: z.string().optional(),
            toolNames: z.array(z.string()).optional(),
            timeoutMs: z.number().positive().optional(),
            maxSteps: z.number().int().positive().optional(),
          }),
        }),
      ),
      execute: async ({ task_id, ...plan }) => {
        const actor = options.getActor();
        const task = await options.port.propose(actor, plan, task_id);
        await sendScheduledTaskConfirmation(options.api, options.port, actor, task);
        endTaskDiscussion(actor);
        return {
          task_id: task.id,
          version: task.pendingVersion,
          status: "awaiting_admin_confirmation",
        };
      },
    }),
    list_scheduled_tasks: tool({
      description: "查看当前聊天任务及下次执行时间，可按任务 ID 查询执行记录。",
      inputSchema: zodToAiSchema(z.object({ task_id: z.string().optional() })),
      execute: async ({ task_id }) =>
        task_id
          ? {
              task: await options.port.get(options.getActor(), task_id),
              runs: await options.port.runs(options.getActor(), task_id),
            }
          : options.port.list(options.getActor()),
    }),
    manage_scheduled_task: tool({
      description:
        "管理员暂停、恢复或取消任务。修改时间、内容、发送位置必须使用 propose_scheduled_task 重新确认。",
      inputSchema: zodToAiSchema(
        z.object({ task_id: z.string(), action: z.enum(["pause", "resume", "cancel"]) }),
      ),
      execute: async ({ task_id, action }) =>
        options.port.manage(options.getActor(), task_id, action),
    }),
  };
}
