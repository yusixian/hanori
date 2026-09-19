import type { BotLogEntry } from "@cos-tool-bot/shared";
import { findTelegramCommandMetadata } from "@cos-tool-bot/shared";
import type { MiddlewareFn } from "grammy";
import type { WrapperContext } from "../context.js";

type OnLog = (entry: BotLogEntry) => void | Promise<void>;

export function createLogMiddleware(onLog?: OnLog): MiddlewareFn<WrapperContext> {
  if (!onLog) return (_ctx, next) => next();

  return (ctx, next) => {
    const from = ctx.from;
    const username = from?.username ?? String(from?.id ?? "unknown");
    const isGroupChat = ctx.chat?.type === "group" || ctx.chat?.type === "supergroup";
    const meta: Record<string, unknown> = {
      userId: from?.id,
      username: from?.username,
      chatId: ctx.chat?.id,
      chatType: ctx.chat?.type,
    };
    if (ctx.update?.update_id !== undefined) meta.updateId = ctx.update.update_id;
    if (ctx.message?.message_id !== undefined) meta.messageId = ctx.message.message_id;

    const hasCommand = ctx.message?.entities?.some((e) => e.type === "bot_command");

    if (hasCommand && ctx.message?.text) {
      const match = ctx.message.text.match(/^\/(\w+)(?:@\S+)?(?:\s+(.*))?/);
      if (match) {
        meta.command = match[1];
        if (!isGroupChat) {
          const redact = findTelegramCommandMetadata(match[1]?.toLowerCase() ?? "")?.redactArgs;
          meta.args = redact ? "[REDACTED]" : (match[2] ?? "");
        }
        onLog({ level: "info", message: `Command /${match[1]} from ${username}`, meta });
      }
    } else if (ctx.message?.text) {
      onLog({
        level: "info",
        message: `Message from ${username}`,
        meta: isGroupChat ? meta : { ...meta, text: ctx.message.text },
      });
    } else if (ctx.message) {
      const msg = ctx.message;

      if (isGroupChat) {
        let type = "Media";
        let mediaKind = "other";
        let durationSeconds: number | undefined;

        if (msg.sticker) {
          type = "Sticker";
          mediaKind = "sticker";
        } else if (msg.photo) {
          type = "Photo";
          mediaKind = "photo";
        } else if (msg.video) {
          type = "Video";
          mediaKind = "video";
          durationSeconds = msg.video.duration;
        } else if (msg.document) {
          type = "Document";
          mediaKind = "document";
        } else if (msg.voice) {
          type = "Voice";
          mediaKind = "voice";
          durationSeconds = msg.voice.duration;
        } else if (msg.animation) {
          type = "GIF";
          mediaKind = "animation";
          durationSeconds = msg.animation.duration;
        }

        meta.mediaKind = mediaKind;
        if (durationSeconds !== undefined) meta.durationSeconds = durationSeconds;
        onLog({ level: "info", message: `${type} from ${username}`, meta });
        return next();
      }

      // Caption commands pass through logging before command guards can reject them.
      const redactCaption = msg.caption_entities?.some((entity) => {
        if (entity.type !== "bot_command") return false;
        const command = msg.caption?.slice(entity.offset + 1, entity.offset + entity.length);
        return findTelegramCommandMetadata(command?.split("@")[0]?.toLowerCase() ?? "")?.redactArgs;
      });
      const caption = redactCaption ? "[REDACTED]" : msg.caption;
      let type: string;

      if (msg.sticker) {
        type = `Sticker ${msg.sticker.emoji ?? ""} (${msg.sticker.set_name ?? "custom"})`;
      } else if (msg.photo) {
        type = caption ? `Photo: ${caption}` : "Photo";
      } else if (msg.video) {
        type = caption
          ? `Video: ${caption}`
          : `Video${msg.video.file_name ? `: ${msg.video.file_name}` : ""}`;
      } else if (msg.document) {
        type = `Document: ${msg.document.file_name ?? "unknown"}`;
      } else if (msg.voice) {
        type = `Voice (${msg.voice.duration}s)`;
      } else if (msg.animation) {
        type = `GIF${msg.animation.file_name ? `: ${msg.animation.file_name}` : ""}`;
      } else {
        type = "Media";
      }

      onLog({ level: "info", message: `${type} from ${username}`, meta });
    }

    return next();
  };
}
