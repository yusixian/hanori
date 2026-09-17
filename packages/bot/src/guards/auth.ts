import type { CommandMiddleware } from "grammy";
import type { WrapperContext } from "../context.js";
import { canAccessAiChat, type AiChatAccessConfig } from "./ai-chat-access.js";

const PERMISSION_DENIED = "[权限不足] 这种事人家确实帮不上忙呢，可以找管理员试试哟～";

export function createAuthGuard(adminIds: number[]): CommandMiddleware<WrapperContext> {
  return async (ctx, next) => {
    if (!ctx.from?.id) return false;
    if (adminIds.includes(ctx.from.id)) {
      await next();
      return true;
    }
    ctx.reply(PERMISSION_DENIED);
    return false;
  };
}

export function createAiSelectionGuard(
  adminIds: number[],
  config: AiChatAccessConfig & { modelCommandAccess?: "admin" | "all" },
): CommandMiddleware<WrapperContext> {
  return async (ctx, next) => {
    const userId = ctx.from?.id;
    const chatId = ctx.chat?.id;
    if (!userId || !chatId) return false;

    if (adminIds.includes(userId)) {
      await next();
      return true;
    }

    if (
      config.modelCommandAccess === "all" &&
      canAccessAiChat(config, {
        chatId,
        userId,
        isPrivate: ctx.chat.type === "private",
        isBotAdmin: false,
      })
    ) {
      await next();
      return true;
    }

    await ctx.reply(PERMISSION_DENIED);
    return false;
  };
}
