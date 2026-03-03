import type { CommandMiddleware } from "grammy";
import type { WrapperContext } from "../context.js";

export interface ImageGenCommandConfig {
  getImageGenEnabled: (chatId: number) => boolean;
  setImageGenEnabled: (chatId: number, enabled: boolean) => void;
}

export function createImageGenCommand(
  cfg: ImageGenCommandConfig,
): CommandMiddleware<WrapperContext> {
  return async (ctx) => {
    const chatId = ctx.chat?.id;
    if (!chatId) return;

    if (ctx.chat?.type === "private") {
      await ctx.reply("此命令仅在群聊中可用。管理员在私聊中默认可使用生图功能。");
      return;
    }

    const args = ctx.match?.toString().trim().toLowerCase();
    if (args === "on") {
      cfg.setImageGenEnabled(chatId, true);
      await ctx.reply("已启用群组生图权限，所有群成员现在可以使用生图功能。");
    } else if (args === "off") {
      cfg.setImageGenEnabled(chatId, false);
      await ctx.reply("已禁用群组生图权限，仅管理员可使用生图功能。");
    } else {
      const enabled = cfg.getImageGenEnabled(chatId);
      await ctx.reply(
        `当前群组生图权限: ${enabled ? "所有成员可用" : "仅管理员可用"}\n` +
          "用法: /imagegen on|off",
      );
    }
  };
}
