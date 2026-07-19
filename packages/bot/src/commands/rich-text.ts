import type { CommandMiddleware } from "grammy";
import type { WrapperContext } from "../context.js";

export interface RichTextCommandConfig {
  getEnabled: () => boolean;
  setEnabled: (enabled: boolean) => Promise<void>;
}

export function createRichTextCommand(
  config: RichTextCommandConfig,
): CommandMiddleware<WrapperContext> {
  return async (ctx) => {
    const argument = ctx.match?.toString().trim().toLowerCase() ?? "";

    if (!argument) {
      return ctx.reply(
        `AI 富文本回复当前${config.getEnabled() ? "已开启" : "已关闭"}（全局生效）。\n` +
          "用法: /richtext on|off",
      );
    }

    if (argument !== "on" && argument !== "off") {
      return ctx.reply("无效的参数。用法: /richtext on|off");
    }

    const enabled = argument === "on";
    try {
      await config.setEnabled(enabled);
      return ctx.reply(
        enabled
          ? "已全局开启 AI 富文本回复。"
          : "已全局关闭 AI 富文本回复，将使用兼容 HTML/纯文本格式。",
      );
    } catch (error) {
      return ctx.reply(
        `富文本设置保存失败: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  };
}
