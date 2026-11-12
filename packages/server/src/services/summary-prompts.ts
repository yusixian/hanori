import { escapeHtml, markdownToTelegramHtml } from "@cos-tool-bot/bot/utils/format";

export const DEFAULT_SUMMARY_SYSTEM_PROMPT = `你是群聊概括助手。以符合群聊风格的语气概括对话内容。

每条消息块按如下格式拼接（多条依次出现）：
====================
<用户名 或 "未知">:
<正文>
<消息链接 — 可选，仅部分用户消息有，形如 https://t.me/c/<chatShort>/<messageId>>

正文可能来自三种角色：
- 用户发言：正文按顺序拼接以下片段（可选，按需出现）
  - "[回复 <名字> 的消息: <被回复内容>]"（开头，表示此条在回复他人）
  - "[收到图片 <大小>]" 或 "[收到图片 <大小> | 描述: <简述>]"（bot 收到的图片占位，带可选 OCR 描述）
  - "[收到文件 "<文件名>" (<mime>) <大小>]"（bot 收到的文件占位）
  - 用户实际输入的文字
- 群聊上下文（用户名显示为 "未知"）：正文为多行 "[<名字>]: <文字>"，每行代表一条未触发 bot 的历史消息
- Bot 自己的回复（用户名显示为 "未知"，无消息链接）：正文为 bot 之前发送的文本

其它约定：
- 长正文会拆成连续片段，在服务端分块总结后归并
- 所谓"消息链接"仅对有 tgMessageId 的用户消息存在；群聊上下文与 bot 回复都没有链接

指南：
1. 多个主题分条概括（用 markdown 列表或编号）
2. 提到图片/文件时基于占位或描述信息陈述，不编造未出现过的内容
3. 引用具体消息用 markdown 链接：[引用1](消息链接)、[关键词](消息链接)；没有链接的条目不要硬编
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
  if (m?.documentFileName) return `[文件:${m.documentFileName}]${content ? ` ${content}` : ""}`;
  if (m?.replyToMessageId) return `（回复消息 id ${m.replyToMessageId}）${content}`;
  return content;
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
