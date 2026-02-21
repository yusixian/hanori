import type { MemoryCallbacks } from "@cos-tool-bot/shared";
import type { CoreTool } from "ai";
import { tool } from "ai";
import type { Api } from "grammy";
import type { ReactionType } from "grammy/types";
import { z } from "zod";
import { zodToAiSchema } from "./utils.js";

export function createMemoryTools(memory: MemoryCallbacks): Record<string, CoreTool> {
  return {
    get_profile: tool({
      description:
        "获取某个用户的档案信息，包括备注、性格特征、兴趣爱好、关系等。当你需要回忆某个人的信息时使用。",
      parameters: zodToAiSchema(
        z.object({
          telegram_id: z.number().describe("用户的 Telegram ID"),
        }),
      ),
      execute: async ({ telegram_id }) => {
        try {
          const profile = await memory.getProfile(telegram_id);
          if (!profile) return { found: false, message: "没有找到该用户的档案" };
          return { found: true, profile };
        } catch (err) {
          return { error: String(err) };
        }
      },
    }),
    update_profile: tool({
      description:
        "更新或创建用户档案。notes 会追加到已有备注后面，traits 和 interests 会与已有的合并去重。当你在对话中了解到用户的新信息时主动使用。",
      parameters: zodToAiSchema(
        z.object({
          telegram_id: z.number().describe("用户的 Telegram ID"),
          username: z.string().optional().describe("用户名（不含@）"),
          display_name: z.string().optional().describe("显示名称"),
          notes: z.string().optional().describe("要追加的备注信息"),
          traits: z.array(z.string()).optional().describe("性格特征标签"),
          interests: z.array(z.string()).optional().describe("兴趣爱好标签"),
          relationship: z.string().optional().describe("与 bot 的关系描述"),
        }),
      ),
      execute: async (data) => {
        try {
          const profile = await memory.upsertProfile({
            telegramId: data.telegram_id,
            username: data.username,
            displayName: data.display_name,
            notes: data.notes,
            traits: data.traits,
            interests: data.interests,
            relationship: data.relationship,
          });
          return { success: true, profile };
        } catch (err) {
          return { error: String(err) };
        }
      },
    }),
    search_profiles: tool({
      description:
        "模糊搜索人物档案。可以按名字、用户名、备注内容、特征或兴趣搜索。当你需要找某个人但不确定其 ID 时使用。",
      parameters: zodToAiSchema(
        z.object({
          query: z.string().describe("搜索关键词"),
        }),
      ),
      execute: async ({ query }) => {
        try {
          const profiles = await memory.searchProfiles(query);
          return { count: profiles.length, profiles };
        } catch (err) {
          return { error: String(err) };
        }
      },
    }),
    search_history: tool({
      description:
        "搜索历史对话记录。可以按关键词搜索，可选按聊天或用户过滤。当用户问「你还记得我说过…」或你需要查找之前的对话内容时使用。",
      parameters: zodToAiSchema(
        z.object({
          query: z.string().describe("搜索关键词"),
          chat_id: z.number().optional().describe("限定在某个聊天中搜索"),
          user_id: z.number().optional().describe("限定某个用户的消息"),
          limit: z.number().optional().describe("返回结果数量上限，默认 20"),
        }),
      ),
      execute: async (data) => {
        try {
          const results = await memory.searchHistory({
            query: data.query,
            chatId: data.chat_id,
            userId: data.user_id,
            limit: data.limit,
          });
          return { count: results.length, results };
        } catch (err) {
          return { error: String(err) };
        }
      },
    }),
  };
}

export interface ActionToolsOptions {
  api: Api;
  chatId: number;
  messageId: number;
  stickerCache: Map<string, string[]>;
}

export function createActionTools(options: ActionToolsOptions): Record<string, CoreTool> {
  const { api, chatId, messageId, stickerCache } = options;

  return {
    react_to_message: tool({
      description: "对当前用户消息添加 emoji 表情回应，如 👍 ❤️ 🔥 😂 😢 🎉 等。",
      parameters: zodToAiSchema(
        z.object({
          emoji: z.string().describe("要添加的 emoji 表情"),
        }),
      ),
      execute: async ({ emoji }) => {
        try {
          const reaction = { type: "emoji", emoji } as unknown as ReactionType;
          await api.setMessageReaction(chatId, messageId, [reaction]);
          return { success: true };
        } catch (err) {
          return { error: String(err) };
        }
      },
    }),
    send_sticker: tool({
      description: "发送一个贴纸来表达情绪。提供一个 emoji 来匹配贴纸包中合适的贴纸。",
      parameters: zodToAiSchema(
        z.object({
          emoji: z.string().describe("用于匹配贴纸的 emoji"),
        }),
      ),
      execute: async ({ emoji }) => {
        try {
          if (stickerCache.size === 0) {
            return { error: "no sticker packs configured" };
          }
          const fileIds = stickerCache.get(emoji);
          if (!fileIds || fileIds.length === 0) {
            const allFileIds = [...stickerCache.values()].flat();
            if (allFileIds.length === 0) return { error: "no matching sticker" };
            const fileId = allFileIds[Math.floor(Math.random() * allFileIds.length)]!;
            await api.sendSticker(chatId, fileId);
            return { success: true, note: "used fallback sticker" };
          }
          const fileId = fileIds[Math.floor(Math.random() * fileIds.length)]!;
          await api.sendSticker(chatId, fileId);
          return { success: true };
        } catch (err) {
          return { error: String(err) };
        }
      },
    }),
  };
}

// Re-export all tool factories
export { createTelegramTools } from "./telegram.js";
export type { TelegramToolsOptions } from "./telegram.js";
export { createBehaviorTools } from "./behavior.js";
export type { BehaviorToolsOptions, MoodInfo } from "./behavior.js";
export { createWebTools } from "./web.js";
export type { WebToolsOptions } from "./web.js";
export { createAgentTools, getAvailableAgentNames } from "./agents.js";
export type { AgentToolsOptions } from "./agents.js";
export { PendingActionRegistry } from "../services/pending-actions.js";
