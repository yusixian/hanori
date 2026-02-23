import type { CommandMiddleware } from "grammy";
import type { ModelEntry } from "@cos-tool-bot/shared";
import type { WrapperContext } from "../context.js";

export interface ModelCommandConfig {
  getModelForChat: (chatId: number) => string;
  setModelForChat: (chatId: number, modelId: string) => void;
  resetModelForChat?: (chatId: number) => void;
  models: ModelEntry[];
  defaultModel: string;
}

export function createModelCommand(config: ModelCommandConfig): CommandMiddleware<WrapperContext> {
  return async (ctx) => {
    const chatId = ctx.chat?.id;
    if (!chatId) return;

    const args = ctx.match?.toString().trim() ?? "";
    const currentModel = config.getModelForChat(chatId);

    // No args: show current model + list
    if (!args) {
      const lines = [`当前模型: \`${currentModel}\``];
      if (config.models.length > 0) {
        lines.push("");
        lines.push("可用模型:");
        for (let i = 0; i < config.models.length; i++) {
          const m = config.models[i]!;
          const active = m.id === currentModel ? " ✅" : "";
          const label = m.label ? ` (${m.label})` : "";
          lines.push(`${i + 1}. \`${m.id}\`${label}${active}`);
        }
        lines.push("");
        lines.push("用法: /model <编号或名称> 切换模型");
        lines.push("/model reset 恢复默认");
      }
      await ctx.reply(lines.join("\n"), { parse_mode: "Markdown" });
      return;
    }

    // Reset
    if (args === "reset") {
      if (config.resetModelForChat) {
        config.resetModelForChat(chatId);
      } else {
        config.setModelForChat(chatId, config.defaultModel);
      }
      await ctx.reply(`已恢复默认模型: \`${config.defaultModel}\``, { parse_mode: "Markdown" });
      return;
    }

    // Try number index
    const idx = Number.parseInt(args, 10);
    if (!Number.isNaN(idx) && idx >= 1 && idx <= config.models.length) {
      const selected = config.models[idx - 1]!;
      config.setModelForChat(chatId, selected.id);
      await ctx.reply(`已切换到模型: \`${selected.id}\``, { parse_mode: "Markdown" });
      return;
    }

    // Try name match
    const match = config.models.find(
      (m) => m.id === args || m.id.toLowerCase() === args.toLowerCase(),
    );
    if (match) {
      config.setModelForChat(chatId, match.id);
      await ctx.reply(`已切换到模型: \`${match.id}\``, { parse_mode: "Markdown" });
      return;
    }

    // Allow setting arbitrary model name (not in the list)
    config.setModelForChat(chatId, args);
    await ctx.reply(`已切换到模型: \`${args}\`\n⚠️ 该模型不在预配置列表中`, {
      parse_mode: "Markdown",
    });
  };
}
