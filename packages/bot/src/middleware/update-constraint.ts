import { findTelegramCommandMetadata } from "@cos-tool-bot/shared";
import type { BotContext } from "../context.js";

export function hasLeadingBotCommand(ctx: BotContext): boolean {
  const entities = ctx.message?.entities ?? ctx.message?.caption_entities ?? [];
  return entities.some((entity) => entity.type === "bot_command" && entity.offset === 0);
}

export function getUpdateConstraint(ctx: BotContext): string | undefined {
  const chatId = ctx.chat?.id.toString();
  if (!hasLeadingBotCommand(ctx)) return chatId;

  const command = ctx.command.name.split("@", 1)[0]?.toLowerCase() ?? "";
  const lane = findTelegramCommandMetadata(command)?.executionLane;
  if (lane === "config") return "command:config";
  if (lane === "operation") return `command:operation:${chatId ?? "unknown"}`;

  // Known control commands and unknown slash commands must never wait for a long AI turn.
  return undefined;
}
