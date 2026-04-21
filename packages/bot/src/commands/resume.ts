import type { CommandMiddleware } from "grammy";
import type { WrapperContext } from "../context.js";

export function createResumeCommand(
  setAiEnabled: (enabled: boolean) => number,
): CommandMiddleware<WrapperContext> {
  return async (ctx) => {
    setAiEnabled(true);
    await ctx.reply("✅ AI 回复已恢复。");
  };
}
