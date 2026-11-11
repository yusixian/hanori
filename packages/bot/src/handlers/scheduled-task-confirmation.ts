import type {
  ScheduledTaskActor,
  ScheduledTaskPort,
  ScheduledTaskRecord,
} from "@cos-tool-bot/shared";
import type { Api } from "grammy";
import { sendConfirmationCard } from "./confirmation-card.js";

export function scheduledTaskText(task: ScheduledTaskRecord): string {
  const p = task.pendingPlan ?? task.activePlan;
  if (!p) return `任务 ${task.id}：${task.status}`;
  const s = p.schedule;
  return [
    "🔐 定时任务计划",
    `名称：${p.name}`,
    `任务 ID：${task.id}`,
    `发起人：${task.proposerName} (${task.proposerId})`,
    `计划版本：${task.pendingVersion ?? task.revision}`,
    `任务：${p.instructions}`,
    `数据/话题范围：${JSON.stringify(p.dataScope)}；来源 ${task.chatId}${task.threadId === null ? " / 非话题消息" : ` / 话题 ${task.threadId}`}`,
    `发送位置：${p.destination.chatId}${p.destination.threadId === undefined ? "" : ` / 话题 ${p.destination.threadId}`}`,
    `时区：${s.timezone}`,
    `周期：${s.kind === "once" ? "一次性" : s.kind === "interval" ? `每 ${s.everySeconds} 秒` : `${s.period} ${s.hour}:${String(s.minute).padStart(2, "0")}${s.weekday === undefined ? "" : ` 星期 ${s.weekday}`}${s.dayOfMonth === undefined ? "" : ` / ${s.dayOfMonth} 日`}`}`,
    `首次执行：${s.kind === "once" ? s.at : s.startsAt}`,
    "错过执行：补最近一期；上次未结束时不重叠",
    `执行 Agent：${p.agentName ?? "默认任务 Agent"} / ${p.agent.providerId ?? "继承默认服务商"} / ${p.agent.modelId ?? "继承默认模型"}`,
    `Agent 覆盖：${JSON.stringify(p.agent)}`,
    `状态：${task.status}；下次执行：${task.nextRunAt ?? "待确认"}`,
    `确认有效期：${task.expiresAt ?? "无待确认计划"}`,
    "批准后持续执行；试跑不会自动启用周期任务。",
  ].join("\n\n");
}
export function scheduledTaskKeyboard(task: ScheduledTaskRecord) {
  if (task.pendingVersion === null) return { inline_keyboard: [] };
  const data = (action: string) => `cos:task:${task.id}:${task.pendingVersion}:${action}`;
  return {
    inline_keyboard: [
      [
        { text: "确认创建/变更", callback_data: data("approve") },
        { text: "试跑一次", callback_data: data("trial") },
      ],
      [
        { text: "修改计划", callback_data: data("edit") },
        { text: "取消提案", callback_data: data("cancel") },
      ],
    ],
  };
}
function compactCard(task: ScheduledTaskRecord) {
  return `定时任务 ${task.id} / 版本 ${task.pendingVersion ?? task.revision}\n状态：${task.status}\n下次执行：${task.nextRunAt ?? "待确认"}\n有效期：${task.expiresAt ?? "无待确认计划"}\n完整计划见本卡前同版本的连续消息；请阅读全部内容后确认。`;
}

export async function sendScheduledTaskConfirmation(
  api: Api,
  port: ScheduledTaskPort,
  actor: ScheduledTaskActor,
  task: ScheduledTaskRecord,
) {
  if (task.pendingVersion === null) throw new Error("任务没有待确认计划");
  const fullText = scheduledTaskText(task);
  if (fullText.length > 4096) {
    let chunk = "";
    let part = 1;
    const sendPart = async () => {
      await optionsSend(chunk, part++);
      chunk = "";
    };
    const optionsSend = (text: string, index: number) =>
      api.sendMessage(
        actor.chatId,
        `任务 ${task.id} / 版本 ${task.pendingVersion} / 全文 ${index}\n${text}`,
        actor.threadId === undefined ? {} : { message_thread_id: actor.threadId },
      );
    for (const character of fullText) {
      if (chunk.length + character.length > 3500) await sendPart();
      chunk += character;
    }
    if (chunk) await sendPart();
  }
  const messageId = await sendConfirmationCard(
    api,
    actor.chatId,
    fullText.length > 4096 ? compactCard(task) : fullText,
    scheduledTaskKeyboard(task),
    actor.threadId,
  );
  await port.bindConfirmation(actor, task.id, task.pendingVersion, messageId);
  return messageId;
}
export function createScheduledTaskConfirmationHandler(options: {
  api: Api;
  botId: string;
  port: ScheduledTaskPort;
  adminIds: readonly number[];
  isDelegatedGroupAdmin?: (chatId: number, userId: number) => Promise<boolean>;
}) {
  return async (ctx: {
    callbackQuery: {
      id: string;
      data?: string;
      from: { id: number; first_name?: string };
      message?: {
        message_id: number;
        chat: { id: number };
        message_thread_id?: number;
        is_topic_message?: boolean;
      };
    };
  }) => {
    const q = ctx.callbackQuery;
    if (!q.data?.startsWith("cos:task:")) return false;
    const match = /^cos:task:([\w-]+):(\d+):(approve|trial|cancel|edit)$/.exec(q.data);
    if (!match || !q.message) {
      await options.api.raw.answerCallbackQuery({
        callback_query_id: q.id,
        text: "无效的任务确认",
        show_alert: true,
      });
      return true;
    }
    const chatId = q.message.chat.id;
    const actor: ScheduledTaskActor = {
      botId: options.botId,
      chatId,
      userId: q.from.id,
      userName: q.from.first_name,
      threadId: q.message.is_topic_message ? q.message.message_thread_id : undefined,
      isBotAdmin: options.adminIds.includes(q.from.id),
      isAdmin:
        options.adminIds.includes(q.from.id) ||
        (chatId < 0 && (await options.isDelegatedGroupAdmin?.(chatId, q.from.id)) === true),
    };
    try {
      if (match[3] === "edit") {
        const task = await options.port.get(actor, match[1]!);
        if (
          !task ||
          task.pendingVersion !== Number(match[2]) ||
          task.confirmationMessageId !== q.message.message_id ||
          !task.expiresAt ||
          Date.parse(task.expiresAt) <= Date.now()
        )
          throw new Error("计划已过期或被新版本替代");
        await options.api.raw.answerCallbackQuery({
          callback_query_id: q.id,
          text: "请回复这张卡说明修改内容；更新后需重新批准。",
          show_alert: true,
        });
        return true;
      }
      const task = await options.port.decide(actor, {
        id: match[1]!,
        version: Number(match[2]),
        messageId: q.message.message_id,
        action: match[3] as "approve" | "trial" | "cancel",
      });
      await options.api.raw.answerCallbackQuery({
        callback_query_id: q.id,
        text: match[3] === "trial" ? "试跑已提交，周期状态不变" : "计划已更新",
      });
      const text = scheduledTaskText(task);
      await options.api.editMessageText(
        chatId,
        q.message.message_id,
        text.length > 4096 ? compactCard(task) : text,
        {
          reply_markup: scheduledTaskKeyboard(task),
        },
      );
    } catch (error) {
      // Failed authorization must leave the owner's card intact.
      await options.api.raw.answerCallbackQuery({
        callback_query_id: q.id,
        text: error instanceof Error ? error.message : "任务操作失败",
        show_alert: true,
      });
    }
    return true;
  };
}
