import type { ConversationCallbacks } from "@cos-tool-bot/shared";
import type { CommandMiddleware } from "grammy";
import type { WrapperContext } from "../context.js";

export function createClearCommand(
  conversation?: ConversationCallbacks,
  adminChatIds: number[] = [],
  beforeClear?: (chatId: number) => Promise<void>,
  runMutation?: (chatId: number, operation: () => Promise<void>) => Promise<void>,
): CommandMiddleware<WrapperContext> {
  return async (ctx) => {
    // 群聊中仅 admin 可用，私聊任何人都能清除自己的上下文
    if (ctx.chat?.type !== "private" && !adminChatIds.includes(ctx.from?.id ?? 0)) {
      return ctx.reply("权限不足：群聊中仅管理员可使用此命令");
    }

    if (!conversation) {
      return ctx.reply("对话历史功能未启用");
    }
    const chatId = ctx.chat?.id;
    if (!chatId) return;
    try {
      const clear = async () => {
        await beforeClear?.(chatId);
        await conversation.clearHistory(chatId);
      };
      if (runMutation) await runMutation(chatId, clear);
      else await clear();
      await ctx.reply("已清除当前对话的历史记录");
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : "未知错误";
      await ctx.reply(`清除对话历史失败: ${msg}`);
    }
  };
}
