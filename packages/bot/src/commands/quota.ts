import type { CommandMiddleware } from "grammy";
import type { WrapperContext } from "../context.js";

export interface QuotaWindowView {
  label: string;
  used: number;
  limit: number;
  resetsAt?: string;
}

export interface QuotaResourceView {
  label: string;
  windows: QuotaWindowView[];
  active: number;
  concurrencyLimit?: number;
}

export interface QuotaCommandConfig {
  getUsage(input: {
    chatId: number;
    userId: number;
    chatType: "private" | "group" | "supergroup";
  }): Promise<{ timezone: string; resources: QuotaResourceView[] }>;
  tighten?: (input: {
    chatId: number;
    actorUserId: number;
    resource: "ai_reply" | "image";
    targetUserId?: number;
    hourly: number;
    daily: number;
    cooldownSeconds?: number;
  }) => Promise<{ ok: boolean; message?: string }>;
}

export function createQuotaCommand(cfg: QuotaCommandConfig): CommandMiddleware<WrapperContext> {
  return async (ctx) => {
    const chatId = ctx.chat?.id;
    const userId = ctx.from?.id;
    const chatType = ctx.chat?.type;
    if (
      chatId === undefined ||
      userId === undefined ||
      (chatType !== "private" && chatType !== "group" && chatType !== "supergroup")
    ) {
      return;
    }

    const args = String(ctx.match ?? "")
      .trim()
      .split(/\s+/)
      .filter(Boolean);
    if (args[0] === "set") {
      if (chatType === "private" || !cfg.tighten) {
        await ctx.reply("群聊限流只能在已授权群聊中设置。");
        return;
      }
      const resource = args[1] === "ai" ? "ai_reply" : args[1] === "image" ? "image" : null;
      const scope = args[2];
      const targetUserId = scope === "user" ? Number(args[3]) : undefined;
      const offset = scope === "user" ? 4 : 3;
      const hourly = Number(args[offset]);
      const daily = Number(args[offset + 1]);
      const cooldownSeconds = args[offset + 2] === undefined ? undefined : Number(args[offset + 2]);
      if (
        !resource ||
        (scope !== "group" && scope !== "user") ||
        (scope === "user" && (!Number.isSafeInteger(targetUserId) || targetUserId! <= 0)) ||
        !Number.isSafeInteger(hourly) ||
        hourly < 0 ||
        !Number.isSafeInteger(daily) ||
        daily < 0 ||
        (cooldownSeconds !== undefined &&
          (!Number.isSafeInteger(cooldownSeconds) || cooldownSeconds < 0))
      ) {
        await ctx.reply(
          "用法：\n/quota set ai|image group <每小时> <每天> [冷却秒]\n/quota set ai|image user <用户ID> <每小时> <每天> [冷却秒]",
        );
        return;
      }
      const result = await cfg.tighten({
        chatId,
        actorUserId: userId,
        resource,
        targetUserId,
        hourly,
        daily,
        cooldownSeconds,
      });
      await ctx.reply(
        result.ok ? "群聊限流已收紧并立即生效。" : (result.message ?? "无法修改限流。"),
      );
      return;
    }

    const usage = await cfg.getUsage({ chatId, userId, chatType });
    const lines = [`用量时区: ${usage.timezone}`];
    for (const resource of usage.resources) {
      lines.push("", resource.label);
      for (const window of resource.windows) {
        lines.push(`• ${window.label}: ${window.used}/${window.limit}`);
      }
      if (resource.concurrencyLimit !== undefined) {
        lines.push(`• 并发: ${resource.active}/${resource.concurrencyLimit}`);
      }
    }
    await ctx.reply(lines.join("\n"));
  };
}
