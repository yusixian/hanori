import { getTelegramCommandMetadata } from "@cos-tool-bot/shared";
import { type Api, GrammyError, InputFile } from "grammy";
import type { ForceReply, InlineKeyboardMarkup } from "grammy/types";
import type {
  HarnessEditResult,
  HarnessKeyboard,
  HarnessMessageKind,
  HarnessOutgoingMessage,
  HarnessTelegram,
} from "./types.js";

const CAPTION_LIMIT = 1024;
const DOWNLOAD_TIMEOUT_MS = 30_000;
/** The harness chat reuses /status and /quota with harness meanings, so it gets its own menu. */
const CHAT_COMMANDS = [
  { command: "status", description: "查看项目、执行机与排队状态" },
  { command: "quota", description: "查看各执行机的模型额度" },
  { command: "bug", description: getTelegramCommandMetadata("bug").description["zh-CN"] },
  { command: "list", description: getTelegramCommandMetadata("list").description["zh-CN"] },
  { command: "cancel", description: getTelegramCommandMetadata("cancel").description["zh-CN"] },
  { command: "retry", description: getTelegramCommandMetadata("retry").description["zh-CN"] },
  { command: "new", description: "清空本话题的助手对话" },
  {
    command: "harness",
    description: getTelegramCommandMetadata("harness").description["zh-CN"],
  },
  { command: "help", description: getTelegramCommandMetadata("help").description["zh-CN"] },
];

export function toMarkup(keyboard: HarnessKeyboard | undefined): InlineKeyboardMarkup {
  return {
    inline_keyboard: (keyboard ?? []).map((row) =>
      row.map((button) =>
        button.url
          ? { text: button.text, url: button.url }
          : { text: button.text, callback_data: button.callbackData ?? "hx:noop" },
      ),
    ),
  };
}

function replyMarkup(message: HarnessOutgoingMessage): InlineKeyboardMarkup | ForceReply {
  if (!message.forceReply) return toMarkup(message.keyboard);
  const { placeholder } = message.forceReply;
  return { force_reply: true, ...(placeholder ? { input_field_placeholder: placeholder } : {}) };
}

function describe(error: unknown): string {
  return error instanceof GrammyError ? error.description : "";
}

function isNotModified(error: unknown): boolean {
  return describe(error).includes("message is not modified");
}

function isMissingMessage(error: unknown): boolean {
  const description = describe(error);
  return (
    description.includes("message to edit not found") ||
    description.includes("MESSAGE_ID_INVALID") ||
    description.includes("message can't be edited")
  );
}

/** Telegram fetches photo URLs itself; private or expired URLs fail with a 400 we can absorb. */
function isRejectedPhoto(error: unknown): boolean {
  return error instanceof GrammyError && error.error_code === 400;
}

async function editResult(operation: () => Promise<unknown>): Promise<HarnessEditResult> {
  try {
    await operation();
    return "edited";
  } catch (error) {
    if (isNotModified(error)) return "unchanged";
    if (isMissingMessage(error)) return "missing";
    throw error;
  }
}

export function createHarnessTelegram(api: Api): HarnessTelegram {
  return {
    async send(chatId, message) {
      const common = {
        parse_mode: "HTML" as const,
        reply_markup: replyMarkup(message),
        ...(message.threadId ? { message_thread_id: message.threadId } : {}),
        ...(message.replyToMessageId
          ? {
              reply_parameters: {
                message_id: message.replyToMessageId,
                allow_sending_without_reply: true,
              },
            }
          : {}),
      };
      if (message.photoUrl && message.html.length <= CAPTION_LIMIT) {
        try {
          const sent = await api.sendPhoto(chatId, message.photoUrl, {
            ...common,
            caption: message.html,
          });
          return { messageId: sent.message_id, kind: "photo" };
        } catch (error) {
          if (!isRejectedPhoto(error)) throw error;
        }
      }
      const sent = await api.sendMessage(chatId, message.html, {
        ...common,
        link_preview_options: { is_disabled: true },
      });
      return { messageId: sent.message_id, kind: "text" };
    },

    async edit(chatId, messageId, kind: HarnessMessageKind, message) {
      const reply_markup = toMarkup(message.keyboard);
      if (kind === "text") {
        return editResult(() =>
          api.editMessageText(chatId, messageId, message.html, {
            parse_mode: "HTML",
            reply_markup,
            link_preview_options: { is_disabled: true },
          }),
        );
      }
      const caption = message.html.slice(0, CAPTION_LIMIT);
      if (message.photoUrl) {
        try {
          return await editResult(() =>
            api.editMessageMedia(
              chatId,
              messageId,
              { type: "photo", media: message.photoUrl!, caption, parse_mode: "HTML" },
              { reply_markup },
            ),
          );
        } catch (error) {
          if (!isRejectedPhoto(error)) throw error;
        }
      }
      return editResult(() =>
        api.editMessageCaption(chatId, messageId, { caption, parse_mode: "HTML", reply_markup }),
      );
    },

    async sendDocument(chatId, document) {
      await api.sendDocument(
        chatId,
        new InputFile(Buffer.from(document.content, "utf8"), document.filename),
        {
          ...(document.caption ? { caption: document.caption, parse_mode: "HTML" as const } : {}),
          ...(document.threadId ? { message_thread_id: document.threadId } : {}),
        },
      );
    },

    async createForumTopic(chatId, name) {
      const topic = await api.createForumTopic(chatId, name);
      return topic.message_thread_id;
    },

    async setChatCommands(chatId) {
      await api.setMyCommands(CHAT_COMMANDS, { scope: { type: "chat", chat_id: chatId } });
    },

    async downloadFile(fileId, maxBytes) {
      const file = await api.getFile(fileId);
      if (!file.file_path || (file.file_size ?? 0) > maxBytes) return null;
      let response: Response;
      try {
        response = await fetch(`https://api.telegram.org/file/bot${api.token}/${file.file_path}`, {
          signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
        });
      } catch {
        // The request URL carries the Bot token; never let it surface in an error message.
        throw new Error("Telegram file download failed");
      }
      if (!response.ok) return null;
      const bytes = Buffer.from(await response.arrayBuffer());
      return bytes.length > maxBytes ? null : bytes;
    },
  };
}
