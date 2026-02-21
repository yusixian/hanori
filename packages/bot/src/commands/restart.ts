import type { CommandMiddleware } from "grammy";
import type { WrapperContext } from "../context.js";

export function createRestartCommand(
  onRestart?: () => void | Promise<void>,
): CommandMiddleware<WrapperContext> {
  return async (ctx) => {
    if (!onRestart) {
      return ctx.reply("重启功能未配置");
    }
    await ctx.wait("正在重启服务...");
    try {
      await ctx.resolveWait("重启命令已执行，bot 将在 2s 后重启");
      setTimeout(async () => {
        await onRestart();
      }, 2000);
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : "未知错误";
      return ctx.resolveWait(`执行出错: ${msg}`);
    }
  };
}
