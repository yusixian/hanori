import type { CommandMiddleware } from "grammy";
import type { WrapperContext } from "../context.js";

export function createAuthGuard(
  adminIds: number[],
): CommandMiddleware<WrapperContext> {
  return async (ctx, next) => {
    if (!ctx.from?.id) return false;
    if (adminIds.includes(ctx.from.id)) {
      await next();
      return true;
    }
    ctx.reply(
      "[权限不足] 这种事人家确实帮不上忙呢，可以找管理员试试哟～",
    );
    return false;
  };
}
