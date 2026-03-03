import type { ReplyMode } from "@cos-tool-bot/shared";
import type { CommandMiddleware } from "grammy";
import type { WrapperContext } from "../context.js";

function describeReplyMode(mode: ReplyMode): string {
  return mode === "stream" ? "流式 (draft 动画)" : "分段 (multi_message 工具)";
}

export interface ReplyModeCommandConfig {
  getReplyMode: () => ReplyMode;
  setReplyMode: (mode: ReplyMode) => void;
}

export function createReplyModeCommand(
  config: ReplyModeCommandConfig,
): CommandMiddleware<WrapperContext> {
  return async (ctx) => {
    const args = ctx.match?.toString().trim().toLowerCase() ?? "";

    if (!args) {
      const desc = describeReplyMode(config.getReplyMode());
      return ctx.reply(
        `当前回复模式: ${desc}\n\n用法:\n/replymode stream - 流式模式\n/replymode segment - 分段模式`,
      );
    }

    if (args !== "stream" && args !== "segment") {
      return ctx.reply("无效的模式。可选: stream / segment");
    }

    config.setReplyMode(args);
    await ctx.reply(`回复模式已切换为: ${describeReplyMode(args)}`);
  };
}
