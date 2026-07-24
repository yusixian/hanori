import type { BotLogEntry } from "@cos-tool-bot/shared";
import type { Tool } from "ai";
import { tool } from "ai";
import type { Api } from "grammy";
import { z } from "zod";
import { sendMarkdownWithFallback } from "../utils/rich-message.js";
import { sleep } from "../utils/sleep.js";
import { stripMetaPrefix } from "../utils/strip-meta-prefix.js";
import { stripThinkingContent } from "../utils/strip-thinking.js";
import { zodToAiSchema } from "./utils.js";

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
  richMessageEnabled?: boolean;
  onLog?: (entry: BotLogEntry) => void | Promise<void>;
  onMultiMessageSent?: (text: string, messageId: number) => void;
}

export function createBehaviorTools(options: BehaviorToolsOptions): Record<string, Tool> {
  const {
    api,
    chatId,
    recentBotMessageIds,
    moodState,
    richMessageEnabled = true,
    onLog,
    onMultiMessageSent,
  } = options;
  const attemptedMultiMessagePayloads = new Set<string>();

  const tools: Record<string, Tool> = {
    multi_message: tool({
      description:
        "分多条消息回复（像真人聊天那样）。每条消息之间会有打字延迟。同一请求可在不同阶段发送不同内容，相同内容会被拦截。使用后不需要再生成普通文本回复。",
      inputSchema: zodToAiSchema(
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
        const cleanedMessages = messages
          .map((msg) => ({
            text: stripMetaPrefix(
              stripThinkingContent(msg.text, ({ pattern, strippedLength }) => {
                onLog?.({
                  level: "info",
                  message: `Stripped thinking content from multi_message (pattern: ${pattern}, ${strippedLength} chars)`,
                  meta: { chatId },
                });
              }),
              ({ pattern, strippedLength }) => {
                onLog?.({
                  level: "warn",
                  message: `Stripped meta prefix from multi_message (pattern: ${pattern}, ${strippedLength} chars)`,
                  meta: { chatId },
                });
              },
            ),
            delayMs: msg.delay_ms,
          }))
          .filter((msg) => !!msg.text);
        const payloadKey = JSON.stringify(cleanedMessages.map((msg) => msg.text));
        if (attemptedMultiMessagePayloads.has(payloadKey)) {
          return {
            blocked: true,
            reason: "Identical multi_message content has already been attempted in this request.",
          };
        }
        attemptedMultiMessagePayloads.add(payloadKey);

        let sentCount = 0;
        try {
          for (const msg of cleanedMessages) {
            if (msg.delayMs) {
              await api.sendChatAction(chatId, "typing");
              await sleep(Math.min(msg.delayMs, 5000));
            }
            const { message } = await sendMarkdownWithFallback(
              api,
              chatId,
              msg.text,
              richMessageEnabled,
              undefined,
              (mode, error) => {
                onLog?.({
                  level: "warn",
                  message: `${mode === "rich" ? "Rich Message" : "HTML"} multi_message delivery failed, falling back`,
                  meta: {
                    chatId,
                    error: error instanceof Error ? error.message : String(error),
                  },
                });
              },
            );
            recentBotMessageIds.push(message.message_id);
            onMultiMessageSent?.(msg.text, message.message_id);
            sentCount++;
          }
          return { sent: sentCount };
        } catch (err) {
          return { sent: sentCount, error: String(err) };
        }
      },
    }),

    set_mood: tool({
      description: "设置你当前的情绪状态。这会影响你后续回复的语气和风格。",
      inputSchema: zodToAiSchema(
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

  return tools;
}
