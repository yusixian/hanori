import type { CommandMiddleware } from "grammy";
import type { SummaryMode } from "@cos-tool-bot/shared";
import type { WrapperContext } from "../context.js";

const MAX_COUNT = 2000;
const MAX_HOURS = 72;

export type SummaryReason =
  | "cooldown"
  | "disabled"
  | "no_access"
  | "too_few_messages"
  | "llm_failed"
  | "no_provider";

export interface SummaryCallbacks {
  botId: string;
  triggerManual(opts: {
    botId: string;
    chatId: number;
    userId: number;
    threadId?: number;
    mode: SummaryMode;
    bypassCooldown?: boolean;
    skipSend?: boolean;
    deliver?: (html: string) => Promise<void>;
  }): Promise<{
    ok: boolean;
    reason?: SummaryReason;
    summaryId?: number;
    contentHtml?: string;
  }>;
  getAccessMode(chatId: number): Promise<"all" | "admin" | null>;
  adminChatIds: number[];
}

const USAGE = `/summary 使用说明：
  /summary         总结最近 24 小时
  /summary 200     总结最近 200 条
  /summary 6h      总结最近 6 小时
  /summary today   总结今天
  /summary yesterday 总结昨日

限制：最多 ${MAX_COUNT} 条 / ${MAX_HOURS} 小时`;

export function parseSummaryArgs(
  raw: string,
): { ok: true; value: SummaryMode } | { ok: false; usage: string } {
  const arg = raw.trim();
  if (!arg) return { ok: true, value: { kind: "default" } };
  if (/^help$/i.test(arg)) return { ok: false, usage: USAGE };

  if (/^(today|yesterday)$/i.test(arg)) {
    return {
      ok: true,
      value: { kind: "date", day: arg.toLowerCase() as "today" | "yesterday" },
    };
  }
  const hoursMatch = /^(\d+)h$/i.exec(arg);
  if (hoursMatch) {
    const hours = Number(hoursMatch[1]);
    if (hours <= 0 || hours > MAX_HOURS) return { ok: false, usage: USAGE };
    return { ok: true, value: { kind: "hours", hours } };
  }
  if (/^\d+$/.test(arg)) {
    const count = Number(arg);
    if (count <= 0 || count > MAX_COUNT) return { ok: false, usage: USAGE };
    return { ok: true, value: { kind: "recent", count } };
  }
  return { ok: false, usage: USAGE };
}

function reasonMessage(reason?: SummaryReason): string {
  switch (reason) {
    case "cooldown":
      return "⏱ 冷却中，稍后再试";
    case "disabled":
      return "群聊总结未启用，请联系管理员";
    case "no_access":
      return "仅管理员可用";
    case "too_few_messages":
      return "消息太少，无需总结";
    case "no_provider":
      return "总结失败：未配置可用的 AI Provider";
    case "llm_failed":
      return "总结失败：LLM 调用异常";
    default:
      return "总结失败";
  }
}

export function createSummaryCommand(deps: SummaryCallbacks): CommandMiddleware<WrapperContext> {
  return async (ctx) => {
    const match = (ctx.match ?? "") as string;
    const parsed = parseSummaryArgs(match);
    if (!parsed.ok) {
      await ctx.reply(parsed.usage);
      return;
    }

    const chatId = ctx.chat?.id;
    const userId = ctx.from?.id;
    if (chatId === undefined || userId === undefined) return;

    // Admin access check (only applies if config row says accessMode="admin")
    const access = await deps.getAccessMode(chatId);
    if (access === "admin" && !deps.adminChatIds.includes(userId)) {
      await ctx.reply(reasonMessage("no_access"));
      return;
    }

    const statusMsg = await ctx.reply("📝 正在总结群聊，稍等…", {
      reply_parameters: ctx.message ? { message_id: ctx.message.message_id } : undefined,
    });

    let delivering = false;
    let result: Awaited<ReturnType<SummaryCallbacks["triggerManual"]>>;
    try {
      result = await deps.triggerManual({
        botId: deps.botId,
        chatId,
        userId,
        mode: parsed.value,
        threadId: ctx.message?.is_topic_message ? ctx.message.message_thread_id : undefined,
        bypassCooldown: deps.adminChatIds.includes(userId),
        skipSend: true,
        deliver: async (html) => {
          delivering = true;
          await ctx.api.deleteMessage(chatId, statusMsg.message_id).catch(() => {});
          await ctx.api.sendMessage(chatId, html, {
            parse_mode: "HTML",
            message_thread_id: ctx.message?.is_topic_message
              ? ctx.message.message_thread_id
              : undefined,
            reply_parameters: ctx.message ? { message_id: ctx.message.message_id } : undefined,
          });
        },
      });
    } catch (err) {
      if (delivering) throw err;
      await ctx.api
        .editMessageText(
          chatId,
          statusMsg.message_id,
          `总结失败：${err instanceof Error ? err.message : String(err)}`,
        )
        .catch(() => {});
      return;
    }

    if (!result.ok) {
      await ctx.api
        .editMessageText(chatId, statusMsg.message_id, reasonMessage(result.reason))
        .catch(() => {});
      return;
    }
  };
}
