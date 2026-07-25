import type { CommandMiddleware } from "grammy";
import type { WrapperContext } from "../context.js";
import { classifyMarkdownDelivery, sendMarkdownWithFallback } from "../utils/rich-message.js";

const USAGE =
  "用法：\n" +
  "/md2tg <markdown> —— 直接转换并发送富文本\n" +
  "回复某条消息再发 /md2tg —— 转换被回复消息的正文\n" +
  "支持：标题、**粗体**、*斜体*、~~删除线~~、`code`、代码块、链接、列表、引用、表格；" +
  "全局开启 richtext 后表格、||spoiler||、==高亮== 等走 Telegram 原生渲染，" +
  "否则回退为 HTML/纯文本";

export interface Md2tgCommandConfig {
  getRichMessageEnabled?: () => boolean;
}

export function createMd2tgCommand(
  config: Md2tgCommandConfig = {},
): CommandMiddleware<WrapperContext> {
  return async (ctx) => {
    const input =
      ctx.command?.original_msg?.trim() ||
      ctx.reply_to_message?.text ||
      ctx.reply_to_message?.caption ||
      "";

    if (!input) return ctx.reply(USAGE);

    const chatId = ctx.chat?.id;
    if (chatId === undefined) return;

    // Share the AI reply delivery pipeline: native Rich Message (tables,
    // spoilers, etc.) when enabled, then HTML, then plain text.
    const richEnabled = config.getRichMessageEnabled?.() ?? false;
    const deliveryClass = classifyMarkdownDelivery(input);
    const result = await sendMarkdownWithFallback(ctx.api, chatId, input, richEnabled);

    if (result.mode === "plain" && deliveryClass !== "plain") {
      await ctx.reply("⚠️ 富文本渲染失败，已回退为原文").catch(() => {});
    }
  };
}
