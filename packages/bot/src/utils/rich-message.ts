import type { Api } from "grammy";
import type { Message, ReplyParameters } from "grammy/types";
import { Marked, type Token, type Tokens } from "marked";
import { markdownToTelegramHtml } from "./format.js";

export type RichMessageFormat = "markdown" | "html";
export type RichDeliveryMode = "rich" | "html" | "plain";
export type MarkdownDeliveryClass = "plain" | "basic" | "rich";

export interface RichMessageOptions {
  message_thread_id?: number;
  reply_parameters?: ReplyParameters;
}

export interface RichDeliveryResult {
  message: Message;
  mode: RichDeliveryMode;
}

const markdownLexer = new Marked();

function isBareLink(token: Tokens.Link): boolean {
  return (
    token.raw === token.text && (token.href === token.text || token.href === `mailto:${token.text}`)
  );
}

function classifyInlineTokens(tokens: Token[]): MarkdownDeliveryClass {
  let deliveryClass: MarkdownDeliveryClass = "plain";

  for (const token of tokens) {
    switch (token.type) {
      case "text": {
        const nested = (token as Tokens.Text).tokens;
        if (!nested) break;
        const nestedClass = classifyInlineTokens(nested);
        if (nestedClass === "rich") return "rich";
        if (nestedClass === "basic") deliveryClass = "basic";
        break;
      }
      case "br":
        break;
      case "escape":
        deliveryClass = "basic";
        break;
      case "strong":
      case "em": {
        const nested = (token as Tokens.Strong | Tokens.Em).tokens;
        if (classifyInlineTokens(nested) === "rich") return "rich";
        deliveryClass = "basic";
        break;
      }
      case "link": {
        const link = token as Tokens.Link;
        if (!isBareLink(link)) return "rich";
        const nestedClass = classifyInlineTokens(link.tokens);
        if (nestedClass === "rich") return "rich";
        if (nestedClass === "basic") deliveryClass = "basic";
        break;
      }
      default:
        return "rich";
    }
  }

  return deliveryClass;
}

function hasRichOnlyInlineSyntax(markdown: string): boolean {
  return [
    /(^|[^\\])\|\|(?=\S)[\s\S]*?\|\|/,
    /(^|[^\\])==(?=\S)[\s\S]*?==/,
    /(^|[^\\])\[\^[^\]\n]+\](?::)?/,
    /(^|[^\\])\$\$(?=\S)[\s\S]*?\$\$/,
    /(^|[^\\])\$(?![\s$])[^$\n]+?\$(?!\$)/,
  ].some((pattern) => pattern.test(markdown));
}

/** Classify whether AI Markdown needs Telegram Rich Message rendering. */
export function classifyMarkdownDelivery(markdown: string): MarkdownDeliveryClass {
  if (hasRichOnlyInlineSyntax(markdown)) return "rich";

  let deliveryClass: MarkdownDeliveryClass = "plain";
  for (const token of markdownLexer.lexer(markdown)) {
    if (token.type === "space") continue;
    if (token.type !== "paragraph" && token.type !== "text") return "rich";

    const inlineTokens = (token as Tokens.Paragraph | Tokens.Text).tokens;
    if (!inlineTokens) continue;
    const inlineClass = classifyInlineTokens(inlineTokens);
    if (inlineClass === "rich") return "rich";
    if (inlineClass === "basic") deliveryClass = "basic";
  }
  return deliveryClass;
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
 * are selected only for structured Markdown and retain HTML/plain fallbacks.
 */
export async function sendMarkdownWithFallback(
  api: Api,
  chatId: number | string,
  markdown: string,
  richMessageEnabled: boolean,
  options?: RichMessageOptions,
  onFallback?: (mode: "rich" | "html", error: unknown) => void,
): Promise<RichDeliveryResult> {
  const deliveryClass = classifyMarkdownDelivery(markdown);

  if (richMessageEnabled && deliveryClass === "rich") {
    try {
      const message = await sendRichMessageStrict(api, chatId, "markdown", markdown, options);
      return { message, mode: "rich" };
    } catch (error) {
      onFallback?.("rich", error);
    }
  }

  if (deliveryClass === "plain") {
    const message = await api.sendMessage(chatId, markdown, options);
    return { message, mode: "plain" };
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

/** Only a definite entity-parser rejection permits a plain-text retry. */
export function isTelegramEntityParseError(error: unknown): boolean {
  const e = error as { error_code?: number; description?: string };
  return (
    e?.error_code === 400 &&
    /can't parse entities|can't find end of|unsupported start tag/i.test(e.description ?? "")
  );
}

export async function editMarkdownMessage(
  api: Api,
  chatId: number,
  messageId: number,
  markdown: string,
  richMessageEnabled: boolean,
): Promise<void> {
  if (richMessageEnabled && classifyMarkdownDelivery(markdown) === "rich") {
    await api.raw.editMessageText({
      chat_id: chatId,
      message_id: messageId,
      rich_message: toInputRichMessage("markdown", markdown),
    });
    return;
  }
  try {
    await api.editMessageText(chatId, messageId, markdownToTelegramHtml(markdown), {
      parse_mode: "HTML",
    });
  } catch (error) {
    if (!isTelegramEntityParseError(error)) throw error;
    await api.editMessageText(chatId, messageId, markdown);
  }
}
