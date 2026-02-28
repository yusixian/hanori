import type { BotLogEntry } from "@cos-tool-bot/shared";
import type { CoreTool } from "ai";
import { tool } from "ai";
import type { Api } from "grammy";
import { z } from "zod";
import { markdownToTelegramHtml } from "../utils/format.js";
import { sleep } from "../utils/sleep.js";
import type { OnceGuardContext } from "./utils.js";
import { wrapOnce, zodToAiSchema } from "./utils.js";

export interface MoodInfo {
  mood: string;
  reason?: string;
  timestamp: number;
}

export interface BehaviorToolsOptions {
  api: Api;
  chatId: number;
  recentBotMessageIds: number[];
  moodState: Map<number, MoodInfo>;
  onLog?: (entry: BotLogEntry) => void | Promise<void>;
  onceGuard?: OnceGuardContext;
}

export function createBehaviorTools(options: BehaviorToolsOptions): Record<string, CoreTool> {
  const { api, chatId, recentBotMessageIds, moodState, onLog, onceGuard } = options;

  const tools: Record<string, CoreTool> = {
    multi_message: tool({
      description:
        "分多条消息回复（像真人聊天那样）。每条消息之间会有打字延迟。使用后不需要再生成普通文本回复。",
      parameters: zodToAiSchema(
        z.object({
          messages: z
            .array(
              z.object({
                text: z.string().describe("消息内容"),
                delay_ms: z.number().min(500).max(5000).optional().describe("发送前的延迟毫秒数"),
              }),
            )
            .min(2)
            .max(5)
            .describe("要发送的消息列表"),
        }),
      ),
      execute: async ({ messages }) => {
        try {
          for (const msg of messages) {
            if (msg.delay_ms) {
              await api.sendChatAction(chatId, "typing");
              await sleep(Math.min(msg.delay_ms, 5000));
            }
            const html = markdownToTelegramHtml(msg.text);
            const sent = await api.sendMessage(chatId, html, { parse_mode: "HTML" });
            recentBotMessageIds.push(sent.message_id);
          }
          return { sent: messages.length };
        } catch (err) {
          return { error: String(err) };
        }
      },
    }),

    set_mood: tool({
      description: "设置你当前的情绪状态。这会影响你后续回复的语气和风格。",
      parameters: zodToAiSchema(
        z.object({
          mood: z.string().describe("当前情绪，如：开心、疲惫、兴奋、沉思、调皮"),
          reason: z.string().optional().describe("情绪变化的原因"),
        }),
      ),
      execute: async ({ mood, reason }) => {
        moodState.set(chatId, { mood, reason, timestamp: Date.now() });
        onLog?.({
          level: "debug",
          message: `[mood] ${mood}${reason ? ` (${reason})` : ""}`,
          meta: { chatId },
        });
        return { mood_set: mood };
      },
    }),
  };

  // Wrap side-effect tools with once guard
  if (onceGuard) {
    const t = tools.multi_message;
    if (t && "execute" in t && typeof t.execute === "function") {
      t.execute = wrapOnce("multi_message", onceGuard, t.execute);
    }
  }

  return tools;
}
