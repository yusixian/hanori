import type { BotLogEntry } from "@cos-tool-bot/shared";
import type { MiddlewareFn } from "grammy";
import type { WrapperContext } from "../context.js";

type OnLog = (entry: BotLogEntry) => void | Promise<void>;

export function createLogMiddleware(onLog?: OnLog): MiddlewareFn<WrapperContext> {
  if (!onLog) return (_ctx, next) => next();

  return (ctx, next) => {
    const from = ctx.from;
    const username = from?.username ?? String(from?.id ?? "unknown");
    const meta: Record<string, unknown> = {
      userId: from?.id,
      username: from?.username,
      chatId: ctx.chat?.id,
      chatType: ctx.chat?.type,
    };

    const hasCommand = ctx.message?.entities?.some(e => e.type === "bot_command");

    if (hasCommand && ctx.message?.text) {
      const match = ctx.message.text.match(/^\/(\w+)(?:@\S+)?(?:\s+(.*))?/);
      if (match) {
        meta.command = match[1];
        meta.args = match[2] ?? "";
        onLog({ level: "info", message: `Command /${match[1]} from ${username}`, meta });
      }
    } else if (ctx.message?.text) {
      onLog({ level: "info", message: `Message from ${username}`, meta: { ...meta, text: ctx.message.text } });
    } else if (ctx.message) {
      const msg = ctx.message;
      let type: string;

      if (msg.sticker) {
        type = `Sticker ${msg.sticker.emoji ?? ""} (${msg.sticker.set_name ?? "custom"})`;
      } else if (msg.photo) {
        type = msg.caption ? `Photo: ${msg.caption}` : "Photo";
      } else if (msg.video) {
        type = msg.caption ? `Video: ${msg.caption}` : `Video${msg.video.file_name ? `: ${msg.video.file_name}` : ""}`;
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
