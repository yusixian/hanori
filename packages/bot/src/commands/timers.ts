import { formatDuration } from "@cos-tool-bot/shared";
import type { TimerRecord } from "@cos-tool-bot/shared";
import type { CommandMiddleware } from "grammy";
import { InlineKeyboard } from "grammy";
import type { WrapperContext } from "../context.js";

const TIMER_CANCEL_PREFIX = "cos:tc:";

interface TimersCommandOptions {
  onGetTimers: () => TimerRecord[];
  onCancelTimer: (timerId: string) => Promise<boolean>;
}

export function createTimersCommand(
  options: TimersCommandOptions,
): CommandMiddleware<WrapperContext> {
  return async (ctx) => {
    const timers = options.onGetTimers();

    if (timers.length === 0) {
      return ctx.reply("当前没有活跃的定时器。");
    }

    const aiTimers = timers.filter((t) => t.type === "ai");
    const systemTimers = timers.filter((t) => t.type === "system");

    const lines: string[] = [`活跃定时器 (${timers.length}):`];

    if (systemTimers.length > 0) {
      lines.push("", "🔧 系统定时器:");
      for (const t of systemTimers) {
        const interval = t.intervalMs ? formatDuration(t.intervalMs) : "N/A";
        lines.push(`  • ${t.name} (每 ${interval})`);
      }
    }

    if (aiTimers.length > 0) {
      lines.push("", "🤖 AI 定时器:");
      for (const t of aiTimers) {
        const firesAt = t.firesAt ? new Date(t.firesAt) : null;
        const remaining = firesAt ? firesAt.getTime() - Date.now() : 0;
        const remainStr = remaining > 0 ? formatDuration(remaining) : "即将触发";
        lines.push(`  • [${t.id}] ${t.name}`);
        lines.push(`    Chat: ${t.chatId ?? "N/A"} | 剩余: ${remainStr}`);
      }
    }

    // Build inline keyboard for AI timer cancellation
    if (aiTimers.length > 0) {
      const keyboard = new InlineKeyboard();
      for (const t of aiTimers) {
        keyboard.text(`❌ ${t.id}`, `${TIMER_CANCEL_PREFIX}${t.id}`).row();
      }
      return ctx.reply(lines.join("\n"), { reply_markup: keyboard });
    }

    return ctx.reply(lines.join("\n"));
  };
}

export function isTimerCancelCallback(data: string): boolean {
  return data.startsWith(TIMER_CANCEL_PREFIX);
}

export function parseTimerCancelId(data: string): string | null {
  if (!data.startsWith(TIMER_CANCEL_PREFIX)) return null;
  return data.slice(TIMER_CANCEL_PREFIX.length);
}
