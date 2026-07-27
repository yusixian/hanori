import type { BotLogEntry } from "@cos-tool-bot/shared";
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
          meta.args = match[1]?.toLowerCase() === "apikey" ? "[REDACTED]" : (match[2] ?? "");
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

      let type: string;

      if (msg.sticker) {
        type = `Sticker ${msg.sticker.emoji ?? ""} (${msg.sticker.set_name ?? "custom"})`;
      } else if (msg.photo) {
        type = msg.caption ? `Photo: ${msg.caption}` : "Photo";
      } else if (msg.video) {
        type = msg.caption
          ? `Video: ${msg.caption}`
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
