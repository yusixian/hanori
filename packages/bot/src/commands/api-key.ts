import type { CommandMiddleware } from "grammy";
import type { WrapperContext } from "../context.js";

export type ApiKeyTarget = "image" | "search";

export interface ApiKeyCommandConfig {
  updateApiKey: (target: ApiKeyTarget, apiKey: string) => Promise<boolean>;
  onError?: (target: ApiKeyTarget) => void | Promise<void>;
}

const USAGE = "用法：/apikey image <key> 或 /apikey search <key>";

export function createApiKeyCommand(
  config: ApiKeyCommandConfig,
): CommandMiddleware<WrapperContext> {
  return async (ctx) => {
    await ctx.deleteMessage().catch(() => {});

    if (ctx.chat?.type !== "private") {
      await ctx.reply("请在与 Bot 的私聊中使用此命令。配置内容不会在群聊中处理。");
      return;
    }

    const args = ctx.match?.toString().trim() ?? "";
    const separator = args.search(/\s/);
    if (separator === -1) {
      await ctx.reply(USAGE);
      return;
    }

    const target = args.slice(0, separator).toLowerCase();
    const apiKey = args.slice(separator).trim();
    if ((target !== "image" && target !== "search") || !apiKey) {
      await ctx.reply(USAGE);
      return;
    }

    try {
      const updated = await config.updateApiKey(target, apiKey);
      if (!updated) {
        await ctx.reply(
          target === "image" ? "当前没有配置图片生成服务。" : "当前没有配置搜索服务。",
        );
        return;
      }
      await ctx.reply(
        target === "image"
          ? "图片生成 API Key 已更新，超时的待处理任务将在后台自动恢复。"
          : "搜索 API Key 已更新。",
      );
    } catch {
      await Promise.resolve(config.onError?.(target)).catch(() => {});
      await ctx.reply("API Key 更新失败，请查看服务日志后重试。");
    }
  };
}
