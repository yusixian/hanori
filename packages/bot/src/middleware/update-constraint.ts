import { findTelegramCommandMetadata } from "@cos-tool-bot/shared";
import type { BotContext } from "../context.js";

export function getUpdateConstraint(ctx: BotContext): string | undefined {
  const chatId = ctx.chat?.id.toString();
  const isCommand = ctx.message?.entities?.some(
    (entity) => entity.type === "bot_command" && entity.offset === 0,
  );
  if (!isCommand) return chatId;

  const command = ctx.command.name.split("@", 1)[0]?.toLowerCase() ?? "";
  const lane = findTelegramCommandMetadata(command)?.executionLane;
  if (lane === "config") return "command:config";
  if (lane === "operation") return `command:operation:${chatId ?? "unknown"}`;

  // Known control commands and unknown slash commands must never wait for a long AI turn.
  return undefined;
}
