import type { Api } from "grammy";
import type { InlineKeyboardMarkup } from "grammy/types";

/** Shared presentation only; each operation keeps its own authorization and state transitions. */
export async function sendConfirmationCard(
  api: Api,
  chatId: number,
  text: string,
  keyboard: InlineKeyboardMarkup,
  threadId?: number,
): Promise<number> {
  const message = await api.sendMessage(chatId, text, {
    reply_markup: keyboard,
    ...(threadId === undefined ? {} : { message_thread_id: threadId }),
  });
  return message.message_id;
}
