import { streamApi } from "@grammyjs/stream";
import type { Api } from "grammy";
import type { Message } from "grammy/types";
import { markdownToTelegramHtml } from "./format.js";

// Monotonic counter for draft IDs to avoid collisions between concurrent streams
let draftIdCounter = 0;

export async function showRichThinkingDraft(
  api: Api,
  chatId: number,
  draftId: number,
): Promise<boolean> {
  try {
    await api.sendRichMessageDraft(chatId, draftId, {
      html: "<tg-thinking>Thinking...</tg-thinking>",
    });
    return true;
  } catch {
    return false;
  }
}

/** Apply the legacy Telegram HTML subset after a plain-text draft stream completes. */
export async function formatSentMessagesHtml(
  api: Api,
  messages: Message.TextMessage[],
): Promise<void> {
  await Promise.allSettled(
    messages.map(async (message) => {
      const html = markdownToTelegramHtml(message.text);
      if (html === message.text) return;
      await api.editMessageText(message.chat.id, message.message_id, html, {
        parse_mode: "HTML",
      });
    }),
  );
}

/**
 * Stream to a private chat using native Rich Markdown or the legacy plain draft path.
 * Used by continue-chat.ts which has a raw Api but no Context.
 *
 * Returns the final sent messages and accumulated text.
 */
export async function streamToChat(
  api: Api,
  chatId: number,
  textStream: AsyncIterable<string>,
  richMessageEnabled = true,
): Promise<{ text: string; sentMessages: Message[] }> {
  const { streamMarkdown, streamMessage } = streamApi(api.raw);
  const draftId = ++draftIdCounter;

  // Collect text for post-processing while streaming
  let accumulated = "";
  async function* trackedStream() {
    for await (const chunk of textStream) {
      accumulated += chunk;
      yield chunk;
    }
  }

  if (richMessageEnabled) {
    await showRichThinkingDraft(api, chatId, draftId);
    const message = await streamMarkdown(chatId, draftId, trackedStream());
    return { text: accumulated.trim(), sentMessages: [message] };
  }

  const messages = await streamMessage(chatId, draftId, trackedStream());
  await formatSentMessagesHtml(api, messages);
  return { text: accumulated.trim(), sentMessages: messages };
}
