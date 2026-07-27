import type { CommandMiddleware } from "grammy";
import type { ModelEntry } from "@cos-tool-bot/shared";
import type { WrapperContext } from "../context.js";

export interface ModelCommandConfig {
  getModelForChat: (chatId: number) => string;
  setModelForChat: (chatId: number, modelId: string) => Promise<void>;
  resetModelForChat?: (chatId: number) => Promise<void>;
  models: ModelEntry[];
  defaultModel: string;
  /** If provided, overrides `models` with a per-chat list (e.g. when provider changes per-chat). */
  getModelsForChat?: (chatId: number) => ModelEntry[];
}

const SAVE_FAILED_MESSAGE = "设置保存失败，请稍后重试。";

export function createModelCommand(config: ModelCommandConfig): CommandMiddleware<WrapperContext> {
  return async (ctx) => {
    const chatId = ctx.chat?.id;
    if (!chatId) return;

    const args = ctx.match?.toString().trim() ?? "";
    const currentModel = config.getModelForChat(chatId);
    const chatModels = config.getModelsForChat ? config.getModelsForChat(chatId) : config.models;

    // No args: show current model + list
    if (!args) {
      const lines = [`当前模型: \`${currentModel}\``];
      if (chatModels.length > 0) {
        lines.push("");
        lines.push("可用模型:");
        for (let i = 0; i < chatModels.length; i++) {
          const m = chatModels[i]!;
          const active = m.id === currentModel ? " ✅" : "";
          const label = m.label ? ` (${m.label})` : "";
          const thinkTag = m.thinking === "enabled" ? " 🧠" : "";
          lines.push(`${i + 1}. \`${m.id}\`${label}${thinkTag}${active}`);
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
      try {
        if (config.resetModelForChat) {
          await config.resetModelForChat(chatId);
        } else {
          await config.setModelForChat(chatId, config.defaultModel);
        }
      } catch {
        await ctx.reply(SAVE_FAILED_MESSAGE);
        return;
      }
      await ctx.reply(`已恢复默认模型: \`${config.defaultModel}\``, { parse_mode: "Markdown" });
      return;
    }

    // Try number index
    const idx = /^\d+$/.test(args) ? Number(args) : Number.NaN;
    if (Number.isInteger(idx) && idx >= 1 && idx <= chatModels.length) {
      const selected = chatModels[idx - 1]!;
      try {
        await config.setModelForChat(chatId, selected.id);
      } catch {
        await ctx.reply(SAVE_FAILED_MESSAGE);
        return;
      }
      await ctx.reply(`已切换到模型: \`${selected.id}\``, { parse_mode: "Markdown" });
      return;
    }

    // Try name match
    const match = chatModels.find(
      (m) => m.id === args || m.id.toLowerCase() === args.toLowerCase(),
    );
    if (match) {
      try {
        await config.setModelForChat(chatId, match.id);
      } catch {
        await ctx.reply(SAVE_FAILED_MESSAGE);
        return;
      }
      await ctx.reply(`已切换到模型: \`${match.id}\``, { parse_mode: "Markdown" });
      return;
    }

    await ctx.reply(`未找到模型: \`${args}\`\n使用 /model 查看可用列表`, {
      parse_mode: "Markdown",
    });
  };
}
