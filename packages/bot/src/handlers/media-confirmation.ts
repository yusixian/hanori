import type { MediaJobActor, MediaJobView, MediaTranscriptionPort } from "@cos-tool-bot/shared";
import type { Api } from "grammy";

export interface MediaConfirmationCallbackOptions {
  api: Api;
  botId: string;
  adminIds: readonly number[];
  port: MediaTranscriptionPort;
}

interface MediaConfirmationContext {
  callbackQuery: {
    id: string;
    data?: string;
    from: { id: number };
    message?: {
      chat: { id: number };
      message_id: number;
      message_thread_id?: number;
    };
  };
}

const callbackPattern = /^cos:asr:([a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}):(yes|no)$/i;
const errorMessages: Readonly<Record<string, string>> = {
  forbidden: "只有在原聊天和话题中发起请求的管理员可以处理此任务",
  not_found: "该转录请求不存在或已过期",
  expired: "该转录确认已过期，请重新发起请求",
  configuration_required: "转录配置已变更或不可用，请重新发起请求",
  quota_exceeded: "转录额度不足，未启动任务",
  duration_limit: "视频时长超过转录限制，未启动任务",
  subtitles_available: "已有平台字幕，未启动音频转录",
  provider_cancellation_unavailable: "已停止本地等待，云端转录任务可能继续运行并计费",
};

function resultMessage(job: MediaJobView): string {
  if (
    job.error === "provider_cancellation_unavailable" ||
    (job.cancelRequested && job.status === "transcribing")
  )
    return "⚠️ 已停止本地等待，云端转录任务可能继续运行并计费";
  if (job.cancelRequested && (job.status === "downloading" || job.status === "converting"))
    return "⏳ 正在停止本地音频处理";
  switch (job.status) {
    case "pending_confirmation":
      return "仍在等待管理员确认";
    case "cancelled":
      return "❌ 已取消";
    case "expired":
      return "❌ 该转录确认已过期，请重新发起请求";
    case "completed":
      return "✅ 音频转录已完成";
    case "failed":
      return "❌ 转录任务未启动或已失败，请查看任务状态";
    default:
      return "✅ 已确认，音频转录任务已入队。结果将发送到原聊天和话题。";
  }
}

export async function sendMediaConfirmationMessage(
  api: Api,
  chatId: number,
  job: MediaJobView,
  threadId?: number,
): Promise<void> {
  const confirmation = job.confirmation;
  if (job.status !== "pending_confirmation" || !confirmation)
    throw new Error("media_confirmation_unavailable");
  const minutes = Math.ceil((job.durationSeconds / 60) * 100) / 100;
  const money = new Intl.NumberFormat("en", { useGrouping: false, maximumSignificantDigits: 8 });
  const amount = (value: number) => money.format(value);
  const text = [
    "🔐 音频转录管理员确认",
    `${job.title.slice(0, 180)} · P${job.part}`,
    `时长：${job.durationSeconds} 秒（约 ${minutes} 分钟）`,
    `ASR 服务：${confirmation.provider} / ${confirmation.model}`,
    `可能付费预估：${amount(confirmation.estimatedCost)} ${confirmation.currency}`,
    `本次费用上限：${amount(confirmation.maxCost)} ${confirmation.currency}`,
    `免费额度：${confirmation.freeQuota}`,
    "优先使用可用免费额度；不足时可能产生上述费用。",
    `外传说明：确认后会将视频音轨发送至 ${confirmation.provider} ASR 服务进行转录，不发送视频画面。`,
    `确认有效期至：${confirmation.expiresAt}`,
    "只有发起请求的 Bot 管理员可以确认。",
  ].join("\n\n");
  await api.sendMessage(chatId, text, {
    ...(threadId === undefined ? {} : { message_thread_id: threadId }),
    reply_markup: {
      inline_keyboard: [
        [
          { text: "确认转录（可能付费）", callback_data: `cos:asr:${job.id}:yes` },
          { text: "取消", callback_data: `cos:asr:${job.id}:no` },
        ],
      ],
    },
  });
}

/** The persisted port binds the requesting admin, chat, topic and expiry across Bot restarts. */
export function createMediaConfirmationCallbackQueryHandler(
  options: MediaConfirmationCallbackOptions,
) {
  return async (ctx: MediaConfirmationContext): Promise<boolean> => {
    const query = ctx.callbackQuery;
    if (!query.data?.startsWith("cos:asr:")) return false;
    const match = callbackPattern.exec(query.data);
    if (!match) {
      await options.api.raw.answerCallbackQuery({
        callback_query_id: query.id,
        text: "该转录确认无效",
        show_alert: true,
      });
      return true;
    }
    const message = query.message;
    if (!options.adminIds.includes(query.from.id) || !message) {
      await options.api.raw.answerCallbackQuery({
        callback_query_id: query.id,
        text: "只有发起该请求的管理员可以确认",
        show_alert: true,
      });
      return true;
    }
    const actor: MediaJobActor = {
      botId: options.botId,
      chatId: message.chat.id,
      userId: query.from.id,
      isAdmin: true,
      ...(message.message_thread_id === undefined ? {} : { threadId: message.message_thread_id }),
    };
    const [, id, decision] = match;
    // Acknowledge Telegram before waiting for durable validation; confirmation only enqueues work.
    await options.api.raw.answerCallbackQuery({
      callback_query_id: query.id,
      text: decision === "yes" ? "正在确认音频转录" : "正在取消音频转录",
    });
    let status: string;
    try {
      const result =
        decision === "yes"
          ? await options.port.confirm(actor, id!)
          : await options.port.cancel(actor, id!);
      status = resultMessage(result);
    } catch (error) {
      const code =
        error !== null && typeof error === "object" && "code" in error ? error.code : undefined;
      if (code === "forbidden" || code === "not_found") {
        await options.api.raw.answerCallbackQuery({
          callback_query_id: query.id,
          text: errorMessages[code],
          show_alert: true,
        });
        return true;
      }
      status =
        typeof code === "string" && Object.hasOwn(errorMessages, code)
          ? `❌ ${errorMessages[code]}`
          : "❌ 无法处理转录请求，请稍后查看任务状态";
    }
    await options.api
      .editMessageText(message.chat.id, message.message_id, `🔐 音频转录管理员确认\n\n${status}`, {
        reply_markup: { inline_keyboard: [] },
      })
      .catch(() => {});
    return true;
  };
}
