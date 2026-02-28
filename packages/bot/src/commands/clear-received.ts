import type { CommandMiddleware } from "grammy";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { WrapperContext } from "../context.js";

export function createClearReceivedCommand(dataDir?: string): CommandMiddleware<WrapperContext> {
  return async (ctx) => {
    if (!dataDir) {
      await ctx.reply("未配置 data 目录，无法清理。");
      return;
    }
    const receivedDir = path.join(dataDir, "received");
    try {
      await fs.rm(receivedDir, { recursive: true, force: true });
      await ctx.reply("✅ 已清理 received 目录。");
    } catch (err) {
      await ctx.reply(`❌ 清理失败: ${err instanceof Error ? err.message : String(err)}`);
    }
  };
}
