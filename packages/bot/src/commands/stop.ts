import type { CommandMiddleware } from "grammy";
import type { WrapperContext } from "../context.js";

export function createStopCommand(
  setAiEnabled: (enabled: boolean) => number,
): CommandMiddleware<WrapperContext> {
  return async (ctx) => {
    const aborted = setAiEnabled(false);
    const suffix = aborted > 0 ? `，已中断 ${aborted} 个正在进行的调用` : "";
    await ctx.reply(`⛔ AI 回复已停用${suffix}。其他命令仍可用。/resume 恢复。`);
  };
}
