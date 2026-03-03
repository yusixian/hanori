import { streamApi } from "@grammyjs/stream";
import type { Api } from "grammy";
import type { Message } from "grammy/types";
import { markdownToTelegramHtml } from "./format.js";

// Monotonic counter for draft IDs to avoid collisions between concurrent streams
let draftIdCounter = 0;

/**
 * Edit sent messages in-place to apply HTML formatting (parallelized).
 * Silently keeps plain text if formatting fails for any message.
 */
export async function formatSentMessagesHtml(
  api: Api,
  messages: Message.TextMessage[],
): Promise<void> {
  if (messages.length === 0) return;
  await Promise.allSettled(
    messages.map(async (msg) => {
      const html = markdownToTelegramHtml(msg.text);
      if (html === msg.text) return; // skip edit if formatting unchanged
      await api.editMessageText(msg.chat.id, msg.message_id, html, {
        parse_mode: "HTML",
      });
    }),
  );
}

/**
 * Stream text to a chat using sendMessageDraft, then finalize with formatted messages.
 * Used by continue-chat.ts which has a raw Api but no Context.
 *
 * Returns the final sent messages and accumulated text.
 */
export async function streamToChat(
  api: Api,
  chatId: number,
  textStream: AsyncIterable<string>,
): Promise<{ text: string; sentMessages: Message.TextMessage[] }> {
  const { streamMessage } = streamApi(api.raw);
  const draftIdOffset = ++draftIdCounter;

  // Collect text for post-processing while streaming
  let accumulated = "";
  async function* trackedStream() {
    for await (const chunk of textStream) {
      accumulated += chunk;
      yield chunk;
    }
  }

  const sentMessages = await streamMessage(chatId, draftIdOffset, trackedStream());

  // Edit sent messages to apply HTML formatting
  await formatSentMessagesHtml(api, sentMessages);

  return { text: accumulated.trim(), sentMessages };
}
