import {
  normalizeQuoteColor,
  QUOTE_COLORS,
  type QuoteSource,
  type UserPrivacyCallbacks,
} from "@cos-tool-bot/shared";
import type { CommandMiddleware } from "grammy";
import type { Message } from "grammy/types";
import type { WrapperContext } from "../context.js";
import { QuoteError, type QuoteService } from "../services/quote-service.js";
import { captureQuoteSource } from "../utils/quote-source.js";

const USAGE = {
  zh: "回复消息发送 /q；选中原文后回复 /q 可引用选段。\n/q 3 向后连引，/q -3 向前连引（1–10 条）；/q r 添加父消息预览；可组合 /q 3 r purple。\n配色：ai / purple / dark / light / blue / #RRGGBB。\n/qcolor <配色|reset> 保存当前聊天默认色（群内限管理员）。",
  en: "Reply with /q, or select text and reply with /q for an excerpt.\n/q 3 quotes forward; /q -3 quotes backward (1–10 messages). /q r includes a parent preview; combine: /q 3 r purple.\nColors: ai / purple / dark / light / blue / #RRGGBB.\n/qcolor <color|reset> saves this chat's default (group admins only).",
};
const english = (ctx: { from?: { language_code?: string } }) =>
  !!ctx.from?.language_code && !ctx.from.language_code.startsWith("zh");
export function parseQuoteArgs(
  raw: string,
): { count: number; includeReplyPreview: boolean; color?: string } | undefined {
  let count = 1,
    includeReplyPreview = false,
    color: string | undefined,
    seenCount = false;
  for (const arg of raw.trim().split(/\s+/).filter(Boolean)) {
    if (/^-?\d+$/.test(arg) && !seenCount) {
      count = Number(arg);
      seenCount = true;
      if (!count || Math.abs(count) > 10) return;
    } else if (arg.toLowerCase() === "r" && !includeReplyPreview) includeReplyPreview = true;
    else if (!color && normalizeQuoteColor(arg)) color = arg;
    else return;
  }
  return { count, includeReplyPreview, color };
}
function sameScope(message: Message, chatId: number, threadId: number | null) {
  return (
    message.chat.id === chatId &&
    (message.is_topic_message ? (message.message_thread_id ?? null) : null) === threadId
  );
}
export function createQuoteCommands(
  service: QuoteService,
  options: { privacy?: UserPrivacyCallbacks; adminIds: readonly number[] },
) {
  const q: CommandMiddleware<WrapperContext> = async (ctx) => {
    const args = parseQuoteArgs(String(ctx.match ?? ""));
    const reply = ctx.message?.reply_to_message;
    if (!args || !reply) {
      await ctx.reply(english(ctx) ? USAGE.en : USAGE.zh);
      return;
    }
    if (!ctx.chat || !ctx.from) return;
    const threadId = ctx.message?.is_topic_message ? (ctx.message.message_thread_id ?? null) : null;
    if (!sameScope(reply, ctx.chat.id, threadId)) {
      await ctx.reply(
        english(ctx)
          ? "The source must be in this chat and topic."
          : "只能引用当前聊天和话题中的消息。",
      );
      return;
    }
    if (ctx.message?.quote && Math.abs(args.count) !== 1) {
      await ctx.reply(
        english(ctx) ? "Selected excerpts support one message only." : "选段只能引用单条消息。",
      );
      return;
    }
    try {
      const captured = await captureQuoteSource(
        reply,
        {
          chatId: ctx.chat.id,
          threadId,
          botUserId: ctx.me.id,
          excerpt: ctx.message?.quote
            ? { text: ctx.message.quote.text, position: ctx.message.quote.position }
            : undefined,
        },
        options.privacy,
      );
      if (!("source" in captured))
        throw new QuoteError(
          "该消息受隐私/保护限制、属于命令，或没有可引用内容。",
          "The source is private, protected, a command, or has no quotable content.",
        );
      const live: QuoteSource[] = [captured.source];
      const parent = reply.reply_to_message;
      if (args.includeReplyPreview && parent && sameScope(parent, ctx.chat.id, threadId)) {
        const result = await captureQuoteSource(
          parent,
          { chatId: ctx.chat.id, threadId, botUserId: ctx.me.id },
          options.privacy,
        );
        if ("source" in result) live.push(result.source);
      }
      const sent = await service.send({
        chatId: ctx.chat.id,
        threadId,
        userId: ctx.from.id,
        anchorId: reply.message_id,
        count: args.count,
        liveSources: live,
        includeReplyPreview: args.includeReplyPreview,
        color: args.color,
        locale: english(ctx) ? "en" : "zh",
        replyToMessageId: ctx.message!.message_id,
      });
      if (sent.notice) await ctx.reply(sent.notice);
      if (!sent.receiptSaved)
        await ctx.reply(
          english(ctx)
            ? "Sent, but its quote receipt could not be saved. Do not retry this request."
            : "已发送，但语录回执未能保存，请勿重复操作。",
        );
    } catch (error) {
      await ctx.reply(
        error instanceof QuoteError
          ? english(ctx)
            ? error.english
            : error.message
          : english(ctx)
            ? "Quote generation or delivery failed. Check the chat before retrying."
            : "语录生成或发送失败，请先查看聊天，避免重复发送。",
      );
    }
  };
  const qcolor: CommandMiddleware<WrapperContext> = async (ctx) => {
    if (!ctx.chat || !ctx.from) return;
    const raw = String(ctx.match ?? "").trim();
    if (!raw) {
      const current = (await service.deps.store.getQuoteColor(ctx.chat.id)) ?? QUOTE_COLORS.dark;
      await ctx.reply(
        `${english(ctx) ? "Current color" : "当前配色"}: ${current}\n${english(ctx) ? USAGE.en : USAGE.zh}`,
      );
      return;
    }
    const reset = raw.toLowerCase() === "reset",
      color = normalizeQuoteColor(raw);
    if (!reset && !color) {
      await ctx.reply(english(ctx) ? USAGE.en : USAGE.zh);
      return;
    }
    if (ctx.chat.type !== "private" && !options.adminIds.includes(ctx.from.id)) {
      const member = await ctx.api.getChatMember(ctx.chat.id, ctx.from.id);
      if (member.status !== "creator" && member.status !== "administrator") {
        await ctx.reply(
          english(ctx)
            ? "Only chat administrators can change the default color."
            : "只有群管理员可以修改群默认配色；单次配色可用 /q purple。",
        );
        return;
      }
    }
    await service.deps.store.setQuoteColor(ctx.chat.id, reset ? undefined : color);
    await ctx.reply(
      english(ctx)
        ? `Quote color saved: ${reset ? QUOTE_COLORS.dark : color}`
        : `语录配色已保存：${reset ? QUOTE_COLORS.dark : color}`,
    );
  };
  return { q, qcolor };
}
