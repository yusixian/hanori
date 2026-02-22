import type { BackupResult } from "@cos-tool-bot/shared";
import type { CommandMiddleware } from "grammy";
import type { WrapperContext } from "../context.js";

export type { BackupResult };

export function createBackupCommand(
  onBackup?: () => Promise<BackupResult>,
): CommandMiddleware<WrapperContext> {
  return async (ctx) => {
    if (!onBackup) {
      return ctx.reply("备份功能未配置");
    }
    await ctx.wait("正在创建数据库备份...");
    try {
      const result = await onBackup();
      if (result.ok) {
        await ctx.resolveWait(`✅ 备份完成: ${result.filename}`);
      } else {
        await ctx.resolveWait(`❌ 备份失败: ${result.error}`);
      }
    } catch (error) {
      const msg = error instanceof Error ? error.message : "未知错误";
      await ctx.resolveWait(`❌ 备份失败: ${msg}`);
    }
  };
}
