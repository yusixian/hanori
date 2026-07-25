import type { BotContext } from "../context.js";

export function getUpdateConstraint(ctx: BotContext): string | undefined {
  const chatId = ctx.chat?.id.toString();

  if (ctx.hasCommand("apikey")) return "apikey";
  if (ctx.hasCommand(["stop", "resume", "md2tg"])) return undefined;

  return chatId;
}
