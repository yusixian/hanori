import type { TelegramCommandLocale } from "@cos-tool-bot/shared";
import type { CommandMiddleware } from "grammy";
import type { WrapperContext } from "../context.js";
import { formatCommandDescription, type ActiveTelegramCommand } from "./registry.js";

export function createHelpCommand(
  getActiveCommands: () => ActiveTelegramCommand[],
  locale: TelegramCommandLocale = "zh-CN",
): CommandMiddleware<WrapperContext> {
  return (ctx) => {
    const contents = getActiveCommands()
      .map((metadata) => `/${metadata.command} - ${formatCommandDescription(metadata, locale)}`)
      .join("\n");
    return ctx.reply(`命令列表：\n${contents}`);
  };
}
