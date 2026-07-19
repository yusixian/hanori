import type { BotContext } from "../context.js";

export function getUpdateConstraint(ctx: BotContext): string | undefined {
  const chatId = ctx.chat?.id.toString();

  if (ctx.hasCommand("apikey")) return "apikey";
  if (ctx.hasCommand(["stop", "resume"])) return undefined;

  return chatId;
}
