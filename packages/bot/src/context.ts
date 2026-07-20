import type { CommandEntity } from "@cos-tool-bot/shared";
import { parseParams } from "@cos-tool-bot/shared";
import type { StreamFlavor } from "@grammyjs/stream";
import { Api, Context } from "grammy";
import type {
  ForceReply,
  InlineKeyboardMarkup,
  Message,
  ParseMode,
  ReplyKeyboardMarkup,
  ReplyKeyboardRemove,
  Update,
  UserFromGetMe,
} from "grammy/types";

export type BotContext = StreamFlavor<WrapperContext>;

export class WrapperContext extends Context {
  waiting_message?: Message;
  private waitingMessagePromise?: Promise<Message>;
  command: CommandEntity;
  isReply: boolean;
  reply_to_message?: Message;

  constructor(update: Update, api: Api, me: UserFromGetMe) {
    super(update, api, me);
    this.command = parseParams(update.message?.text ?? "");
    if (update.message?.reply_to_message) {
      this.isReply = true;
      this.reply_to_message = update.message.reply_to_message;
    } else this.isReply = false;
  }

  autoDelete(timeout?: number) {
    if (!timeout) timeout = 20000;
    setTimeout(async () => {
      if (this.waiting_message) {
        try {
          await this.deleteMessages([this.waiting_message.message_id]);
        } catch (_e) {
          // ignore delete errors
        }
      }
    }, timeout);
  }

  async directlyReply(
    message: string,
    parse_mode?: ParseMode,
    reply_markup?: InlineKeyboardMarkup | ReplyKeyboardMarkup | ReplyKeyboardRemove | ForceReply,
  ) {
    return await this.reply(message, {
      reply_parameters:
        this.chat?.type === "private" ? undefined : { message_id: this.message!.message_id },
      parse_mode,
      reply_markup,
    });
  }

  async wait(message: string, auto_delete?: boolean, parse_mode?: ParseMode) {
    await this.getOrCreateWaiting(message, parse_mode);
    if (auto_delete) this.autoDelete();
  }

  async resolveWait(message: string, parse_mode?: ParseMode): Promise<number> {
    const waiting = await this.getOrCreateWaiting(message, parse_mode);
    if (waiting.created) return waiting.message.message_id;

    await this.api.editMessageText(waiting.message.chat.id, waiting.message.message_id, message, {
      parse_mode,
    });
    return waiting.message.message_id;
  }

  async deleteWaiting() {
    const pending = this.waitingMessagePromise;
    if (pending) await pending.catch(() => undefined);
    if (this.waiting_message) {
      const msgId = this.waiting_message.message_id;
      this.waiting_message = undefined;
      await this.deleteMessages([msgId]).catch(() => {});
    }
  }

  private async getOrCreateWaiting(
    message: string,
    parse_mode?: ParseMode,
  ): Promise<{ message: Message; created: boolean }> {
    if (this.waiting_message) return { message: this.waiting_message, created: false };
    if (this.waitingMessagePromise) {
      return { message: await this.waitingMessagePromise, created: false };
    }

    const pending = this.directlyReply(message, parse_mode).then((sent) => {
      this.waiting_message = sent;
      return sent;
    });
    this.waitingMessagePromise = pending;
    try {
      return { message: await pending, created: true };
    } finally {
      if (this.waitingMessagePromise === pending) this.waitingMessagePromise = undefined;
    }
  }
}
