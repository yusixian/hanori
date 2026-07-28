import type { CommandMiddleware } from "grammy";
import type { BotRuntimeState } from "../handlers/ai-reply.js";
import type { MoodInfo } from "../tools/index.js";
import type { WrapperContext } from "../context.js";

export interface StatusCommandConfig {
  model: string;
  conversationEnabled: boolean;
  memoryEnabled: boolean;
  webToolsEnabled: boolean;
  agentToolsEnabled: boolean;
  stickerPacksCount: number;
}

function formatElapsed(ms: number): string {
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 1) return "刚刚";
  if (minutes < 60) return `${minutes}分钟前`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}小时前`;
  return `${Math.floor(hours / 24)}天前`;
}

function formatMood(mood: MoodInfo): string {
  const timeStr = formatElapsed(Date.now() - mood.timestamp);
  let str = mood.mood;
  if (mood.reason) str += ` — ${mood.reason}`;
  str += ` (${timeStr})`;
  return str;
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function formatDurationMs(ms: number): string {
  if (ms < 1_000) return `${Math.round(ms)}ms`;
  return `${(ms / 1_000).toFixed(1)}s`;
}

export function createStatusCommand(
  aiConfig?: StatusCommandConfig,
  state?: BotRuntimeState,
): CommandMiddleware<WrapperContext> {
  return async (ctx) => {
    const chatId = ctx.chat?.id;
    const lines: string[] = [];

    lines.push("🤖 <b>Bot 状态</b>");

    if (!aiConfig) {
      lines.push("");
      lines.push("AI 功能未启用");
      return ctx.reply(lines.join("\n"), { parse_mode: "HTML" });
    }

    const check = (v: boolean) => (v ? "✅" : "❌");

    lines.push("");
    lines.push("⚙️ <b>配置</b>");
    lines.push(`• 模型: <code>${escapeHtml(aiConfig.model)}</code>`);
    lines.push(`• 对话历史: ${check(aiConfig.conversationEnabled)}`);
    lines.push(`• 记忆系统: ${check(aiConfig.memoryEnabled)}`);
    lines.push(`• Web 工具: ${check(aiConfig.webToolsEnabled)}`);
    lines.push(`• Agent 委派: ${check(aiConfig.agentToolsEnabled)}`);
    if (aiConfig.stickerPacksCount > 0) {
      lines.push(`• 贴纸包: ${aiConfig.stickerPacksCount} 个`);
    }

    if (state) {
      const execution = state.getAiExecutionStats();
      const averageWaitMs = execution.started > 0 ? execution.totalWaitMs / execution.started : 0;
      const averageRunMs = execution.started > 0 ? execution.totalRunMs / execution.started : 0;
      lines.push("");
      lines.push("🧠 <b>AI 执行队列</b>");
      lines.push(`• 运行中: ${execution.active}/${execution.maxConcurrent}`);
      lines.push(`• 排队: ${execution.queued}`);
      lines.push(
        `• 完成/拒绝/取消: ${execution.completed}/${execution.rejected}/${execution.cancelled}`,
      );
      lines.push(
        `• 平均等待/运行: ${formatDurationMs(averageWaitMs)}/${formatDurationMs(averageRunMs)}`,
      );

      // Current chat mood
      lines.push("");
      if (chatId) {
        const mood = state.getMood(chatId);
        if (mood) {
          lines.push(`🎭 <b>当前聊天情绪</b>: ${escapeHtml(formatMood(mood))}`);
        } else {
          lines.push("🎭 <b>当前聊天情绪</b>: 无");
        }
      }

      // All moods
      const allMoods = state.getAllMoods();
      if (allMoods.size > 0) {
        lines.push("");
        lines.push(`📊 <b>全局情绪 (${allMoods.size} 个聊天)</b>`);
        for (const [cid, mood] of allMoods) {
          const marker = cid === chatId ? "👉 " : "   ";
          lines.push(`${marker}<code>${cid}</code>: ${escapeHtml(formatMood(mood))}`);
        }
      }

      // Active groups
      const groupCount = state.getActiveGroupCount();
      if (groupCount > 0) {
        lines.push("");
        lines.push(`💬 活跃群组缓存: ${groupCount} 个`);
      }
    }

    return ctx.reply(lines.join("\n"), { parse_mode: "HTML" });
  };
}
