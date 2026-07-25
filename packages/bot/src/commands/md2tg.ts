import type { CommandMiddleware } from "grammy";
import { GrammyError } from "grammy";
import type { WrapperContext } from "../context.js";
import { markdownToTelegramHtml } from "../utils/format.js";

const USAGE =
  "用法：\n" +
  "/md2tg <markdown> —— 直接转换并发送富文本\n" +
  "回复某条消息再发 /md2tg —— 转换被回复消息的正文\n" +
  "支持：标题、**粗体**、*斜体*、~~删除线~~、`code`、代码块、链接、列表、引用，" +
  "也可以直接写 Telegram HTML 标签，如 <u>下划线</u>、<tg-spoiler>剧透</tg-spoiler>";

export const md2tgCommand: CommandMiddleware<WrapperContext> = async (ctx) => {
  const input =
    ctx.command?.original_msg?.trim() ||
    ctx.reply_to_message?.text ||
    ctx.reply_to_message?.caption ||
    "";

  if (!input) return ctx.reply(USAGE);

  let html: string;
  try {
    html = markdownToTelegramHtml(input);
  } catch {
    return ctx.reply("转换失败，请检查输入的 Markdown 格式是否正确");
  }

  try {
    return await ctx.reply(html, { parse_mode: "HTML" });
  } catch (error) {
    if (error instanceof GrammyError) {
      // Telegram rejected the converted HTML — fall back to the raw text.
      return ctx.reply(`⚠️ 富文本发送失败（${error.description}），回退为原文：\n\n${input}`);
    }
    throw error;
  }
};
