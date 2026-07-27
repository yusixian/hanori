import type { CommandMiddleware } from "grammy";
import type { WrapperContext } from "../context.js";

export interface ProviderCommandConfig {
  getProviderForChat: (chatId: number) => string | undefined;
  setProviderForChat: (chatId: number, providerId: string) => Promise<void>;
  resetProviderForChat: (chatId: number) => Promise<void>;
  providers: Array<{ id: string; label: string; defaultModel: string }>;
  defaultProviderId: string;
}

const SAVE_FAILED_MESSAGE = "设置保存失败，请稍后重试。";

export function createProviderCommand(
  config: ProviderCommandConfig,
): CommandMiddleware<WrapperContext> {
  return async (ctx) => {
    const chatId = ctx.chat?.id;
    if (!chatId) return;

    const args = ctx.match?.toString().trim() ?? "";
    const currentId = config.getProviderForChat(chatId) ?? config.defaultProviderId;

    // No args: show current + list
    if (!args) {
      const current = config.providers.find((p) => p.id === currentId);
      const currentLabel = current?.label ?? "(未配置)";
      const lines = [`当前 Provider: \`${currentLabel}\``];
      if (config.providers.length > 0) {
        lines.push("");
        lines.push("可用 Provider:");
        for (let i = 0; i < config.providers.length; i++) {
          const p = config.providers[i]!;
          const active = p.id === currentId ? " ✅" : "";
          lines.push(`${i + 1}. \`${p.label}\` (default: ${p.defaultModel})${active}`);
        }
        lines.push("");
        lines.push("用法: /provider <编号或名称> 切换");
        lines.push("/provider reset 恢复默认");
      }
      await ctx.reply(lines.join("\n"), { parse_mode: "Markdown" });
      return;
    }

    if (args === "reset") {
      try {
        await config.resetProviderForChat(chatId);
      } catch {
        await ctx.reply(SAVE_FAILED_MESSAGE);
        return;
      }
      const def = config.providers.find((p) => p.id === config.defaultProviderId);
      await ctx.reply(`已恢复默认 Provider: \`${def?.label ?? config.defaultProviderId}\``, {
        parse_mode: "Markdown",
      });
      return;
    }

    // Number index
    const idx = /^\d+$/.test(args) ? Number(args) : Number.NaN;
    if (Number.isInteger(idx) && idx >= 1 && idx <= config.providers.length) {
      const selected = config.providers[idx - 1]!;
      try {
        await config.setProviderForChat(chatId, selected.id);
      } catch {
        await ctx.reply(SAVE_FAILED_MESSAGE);
        return;
      }
      await ctx.reply(`已切换到 Provider: \`${selected.label}\``, { parse_mode: "Markdown" });
      return;
    }

    // Match by id or label (case-insensitive on label)
    const match = config.providers.find(
      (p) => p.id === args || p.label === args || p.label.toLowerCase() === args.toLowerCase(),
    );
    if (match) {
      try {
        await config.setProviderForChat(chatId, match.id);
      } catch {
        await ctx.reply(SAVE_FAILED_MESSAGE);
        return;
      }
      await ctx.reply(`已切换到 Provider: \`${match.label}\``, { parse_mode: "Markdown" });
      return;
    }

    await ctx.reply(`未找到 Provider: \`${args}\`\n使用 /provider 查看可用列表`, {
      parse_mode: "Markdown",
    });
  };
}
