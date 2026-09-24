import { InputFile, type MiddlewareFn } from "grammy";
import type { Message } from "grammy/types";
import type { BotContext } from "../context.js";
import { toMarkup } from "./telegram.js";
import {
  HARNESS_CALLBACK_PREFIX,
  HARNESS_COMMANDS,
  type HarnessAttachment,
  type HarnessBotPort,
  type HarnessCommandName,
  type HarnessReply,
} from "./types.js";

function topicThreadId(message: Pick<Message, "is_topic_message" | "message_thread_id">) {
  return message.is_topic_message ? message.message_thread_id : undefined;
}

function leadingCommand(message: Message): { name: string; target?: string; args: string } | null {
  const text = message.text ?? message.caption;
  const entities = message.entities ?? message.caption_entities ?? [];
  const entity = entities.find((item) => item.type === "bot_command" && item.offset === 0);
  if (!text || !entity) return null;
  const [name = "", target] = text.slice(1, entity.length).split("@", 2);
  return { name: name.toLowerCase(), target, args: text.slice(entity.length).trim() };
}

function attachmentsOf(...messages: Array<Message | undefined>): HarnessAttachment[] {
  const attachments: HarnessAttachment[] = [];
  for (const message of messages) {
    const photo = message?.photo?.at(-1);
    if (photo) attachments.push({ kind: "photo", fileId: photo.file_id });
    if (message?.document) attachments.push({ kind: "document", fileId: message.document.file_id });
  }
  return attachments;
}

async function send(ctx: BotContext, reply: HarnessReply) {
  if (reply.document) {
    await ctx.replyWithDocument(
      new InputFile(Buffer.from(reply.document.content, "utf8"), reply.document.filename),
      { caption: reply.html || undefined, parse_mode: "HTML" },
    );
    return;
  }
  if (!reply.html) return;
  await ctx.reply(reply.html, {
    parse_mode: "HTML",
    link_preview_options: { is_disabled: true },
    ...(reply.keyboard ? { reply_markup: toMarkup(reply.keyboard) } : {}),
  });
}

function isConversationalMessage(message: Message): boolean {
  return Boolean(
    message.text ??
    message.caption ??
    message.photo ??
    message.document ??
    message.voice ??
    message.sticker,
  );
}

/**
 * Owns every update from the harness chat: non-owners are ignored, harness commands and buttons
 * go to the port, and other owner commands fall through. Ordinary messages never reach casual
 * AI replies or JEV engagement unless the config explicitly allows casual replies.
 */
export function createHarnessMiddleware(port: HarnessBotPort): MiddlewareFn<BotContext> {
  return async (ctx, next) => {
    const chatId = ctx.chat?.id;
    if (chatId === undefined || !port.isHarnessChat(chatId)) return next();
    const userId = ctx.from?.id;
    const isOwner = userId !== undefined && port.isOwner(userId);

    const callback = ctx.callbackQuery;
    if (callback) {
      if (!isOwner) {
        await ctx.answerCallbackQuery({ text: "无权限" }).catch(() => {});
        return;
      }
      if (!callback.data?.startsWith(HARNESS_CALLBACK_PREFIX) || !callback.message) return next();
      const answer = await port.handleCallback({
        data: callback.data,
        chatId,
        threadId: topicThreadId(callback.message),
        messageId: callback.message.message_id,
        userId,
      });
      await ctx
        .answerCallbackQuery({ text: answer.text, show_alert: answer.alert ?? false })
        .catch(() => {});
      return;
    }

    const message = ctx.message;
    if (!message) return next();
    if (!isOwner || message.from?.is_bot) return;

    const command = leadingCommand(message);
    if (command?.target && command.target.toLowerCase() !== ctx.me.username.toLowerCase()) return;
    if (command && (HARNESS_COMMANDS as readonly string[]).includes(command.name)) {
      const reply = await port.handleCommand({
        command: command.name as HarnessCommandName,
        args: command.args,
        chatId,
        threadId: topicThreadId(message),
        userId,
        messageId: message.message_id,
        attachments: attachmentsOf(message, message.reply_to_message),
        botUsername: ctx.me.username,
      });
      await send(ctx, reply);
      return;
    }
    if (command) return next();
    const repliedTo = message.reply_to_message;
    if (repliedTo?.from?.id === ctx.me.id) {
      const reply = await port.handleReply({
        chatId,
        threadId: topicThreadId(message),
        userId,
        messageId: message.message_id,
        replyToMessageId: repliedTo.message_id,
        text: message.text ?? message.caption ?? "",
      });
      if (reply) {
        await send(ctx, reply);
        return;
      }
    }
    if (port.allowsCasualReplies()) return next();
    if (!isConversationalMessage(message)) return;
    await ctx.reply(port.usageHint(topicThreadId(message)), { parse_mode: "HTML" });
  };
}
