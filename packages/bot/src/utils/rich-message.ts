import type { Api } from "grammy";
import type { Message, ReplyParameters } from "grammy/types";
import { markdownToTelegramHtml } from "./format.js";

export type RichMessageFormat = "markdown" | "html";
export type RichDeliveryMode = "rich" | "html" | "plain";

export interface RichMessageOptions {
  message_thread_id?: number;
  reply_parameters?: ReplyParameters;
}

export interface RichDeliveryResult {
  message: Message;
  mode: RichDeliveryMode;
}

export function toInputRichMessage(format: RichMessageFormat, content: string) {
  return format === "markdown" ? { markdown: content } : { html: content };
}

export async function sendRichMessageStrict(
  api: Api,
  chatId: number | string,
  format: RichMessageFormat,
  content: string,
  options?: RichMessageOptions,
): Promise<Message.RichMessageMessage> {
  return api.sendRichMessage(chatId, toInputRichMessage(format, content), options);
}

/**
 * Send AI Markdown through the configured delivery path. Native Rich Messages
 * retain the legacy HTML/plain fallbacks; disabling them starts at HTML.
 */
export async function sendMarkdownWithFallback(
  api: Api,
  chatId: number | string,
  markdown: string,
  richMessageEnabled: boolean,
  options?: RichMessageOptions,
  onFallback?: (mode: "rich" | "html", error: unknown) => void,
): Promise<RichDeliveryResult> {
  if (richMessageEnabled) {
    try {
      const message = await sendRichMessageStrict(api, chatId, "markdown", markdown, options);
      return { message, mode: "rich" };
    } catch (error) {
      onFallback?.("rich", error);
    }
  }

  try {
    const html = markdownToTelegramHtml(markdown);
    const message = await api.sendMessage(chatId, html, { ...options, parse_mode: "HTML" });
    return { message, mode: "html" };
  } catch (error) {
    onFallback?.("html", error);
  }

  const message = await api.sendMessage(chatId, markdown, options);
  return { message, mode: "plain" };
}
