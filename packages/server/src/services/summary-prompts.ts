import { escapeHtml, markdownToTelegramHtml } from "@cos-tool-bot/bot/utils/format";

export const DEFAULT_SUMMARY_SYSTEM_PROMPT = `你是群聊概括助手。以符合群聊风格的语气概括对话内容。

对话按以下格式提供：
====================
用户名:
发言内容
[图片] / [文件:文件名] / 消息链接
====================

指南：
1. 多个主题分条概括（用 markdown 列表或编号）
2. 提到图片/文件用占位描述，不编造内容
3. 引用具体消息用 markdown 链接：[引用1](消息链接)、[关键词](消息链接)
4. 开头固定："**本次群聊总结如下：**"
5. 不要使用 markdown 引用块（>），保持纯段落/列表/链接`;

export const DEFAULT_WINDOW_HOURS = 24;
export const DEFAULT_MAX_MESSAGES = 2000;
export const DEFAULT_COOLDOWN_SECONDS = 300;
export const DEFAULT_TIMEZONE = "Asia/Shanghai";
export const DEFAULT_ROLE_FILTER = ["user", "context", "assistant"] as const;
export const MIN_MESSAGES_FOR_SUMMARY = 5;
export const MAX_COUNT = 2000;
export const MAX_HOURS = 72;

export function messageLink(chatId: number, tgMessageId?: number | null): string {
  if (!tgMessageId) return "";
  const s = String(chatId);
  const short = s.startsWith("-100") ? s.slice(4) : String(Math.abs(chatId));
  return `https://t.me/c/${short}/${tgMessageId}`;
}

export interface FormattableMessage {
  userName: string | null;
  content: string;
  meta: unknown;
}

export function dispatchContent(content: string, meta: unknown): string {
  const m = meta as {
    photoFileId?: string;
    documentFileName?: string;
    replyToMessageId?: number;
  } | null;
  if (m?.photoFileId) return "[图片]" + (content ? ` ${content}` : "");
  if (m?.documentFileName) return `[文件:${m.documentFileName}]`;
  if (m?.replyToMessageId) return `（回复消息 id ${m.replyToMessageId}）${content}`;
  return content.length > 2000 ? content.slice(0, 2000) + "…" : content;
}

export function formatMessages(msgs: FormattableMessage[], chatId: number): string {
  return msgs
    .map((m) => {
      const tgId = (m.meta as { tgMessageId?: number } | null)?.tgMessageId;
      const link = messageLink(chatId, tgId);
      const body = dispatchContent(m.content, m.meta);
      const name = m.userName ?? "未知";
      return `====================\n${name}:\n${body}${link ? "\n" + link : ""}`;
    })
    .join("\n");
}

export function wrapSummaryHtml(llmMarkdown: string): string {
  const inner = markdownToTelegramHtml(llmMarkdown).trim();
  return `<blockquote expandable>${inner}</blockquote>`;
}

export { escapeHtml };
