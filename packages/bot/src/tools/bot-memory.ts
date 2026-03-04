import type { BotMemoryCallbacks, PeopleProfile } from "@cos-tool-bot/shared";
import type { Tool } from "ai";
import { tool } from "ai";
import { z } from "zod";
import { zodToAiSchema } from "./utils.js";

export function createBotMemoryTools(callbacks: BotMemoryCallbacks): Record<string, Tool> {
  return {
    save_memory: tool({
      description:
        "保存一条长期记忆。可以是通用记忆（群规则、偏好、事实等），也可以关联到特定用户。记忆会跨对话持久保存。",
      inputSchema: zodToAiSchema(
        z.object({
          content: z.string().describe("要保存的记忆内容"),
          category: z
            .string()
            .optional()
            .describe('记忆分类，如 "fact"、"preference"、"rule"、"event"'),
          telegram_id: z.number().optional().describe("关联的用户 Telegram ID，不提供则为通用记忆"),
          fact_valid_at: z
            .string()
            .optional()
            .describe('事实发生/有效的时间（ISO 8601格式），如 "2025-03-01T12:00:00Z"'),
        }),
      ),
      execute: async ({ content, category, telegram_id, fact_valid_at }) => {
        try {
          const memory = await callbacks.saveMemory({
            content,
            category,
            telegramId: telegram_id,
            factValidAt: fact_valid_at,
          });
          return { success: true, memory };
        } catch (err) {
          return { error: String(err) };
        }
      },
    }),
    recall_memories: tool({
      description:
        "回忆/搜索已保存的记忆。可以按关键词、分类、用户过滤。用于回忆之前保存的事实、规则或偏好。同时自动搜索匹配的用户档案。",
      inputSchema: zodToAiSchema(
        z.object({
          query: z.string().optional().describe("搜索关键词"),
          category: z.string().optional().describe("按分类过滤"),
          telegram_id: z.number().optional().describe("按用户 Telegram ID 过滤"),
          scope: z
            .enum(["general_only", "user_only", "all"])
            .optional()
            .describe(
              "搜索范围: general_only=仅通用记忆, user_only=仅指定用户记忆, all=全部（默认）",
            ),
          limit: z.number().optional().describe("返回数量上限，默认 20"),
        }),
      ),
      execute: async ({ query, category, telegram_id, scope, limit }) => {
        try {
          const memories = await callbacks.recallMemories({
            query,
            category,
            telegramId: telegram_id,
            scope,
            limit,
          });

          let matchedProfiles: PeopleProfile[] = [];
          if (callbacks.searchProfiles && query) {
            try {
              matchedProfiles = await callbacks.searchProfiles(query, telegram_id);
            } catch {
              /* profile 搜索失败不影响主流程 */
            }
          }

          return {
            count: memories.length,
            memories,
            ...(matchedProfiles.length > 0 && {
              matchedProfiles,
              profileCount: matchedProfiles.length,
            }),
          };
        } catch (err) {
          return { error: String(err) };
        }
      },
    }),
    delete_memory: tool({
      description: "删除一条已保存的记忆。当记忆不再准确或不再需要时使用。",
      inputSchema: zodToAiSchema(
        z.object({
          memory_id: z.number().describe("要删除的记忆 ID"),
        }),
      ),
      execute: async ({ memory_id }) => {
        try {
          const deleted = await callbacks.deleteMemory(memory_id);
          return { success: deleted };
        } catch (err) {
          return { error: String(err) };
        }
      },
    }),
  };
}
