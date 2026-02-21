import type { MemoryCallbacks } from "@cos-tool-bot/shared";
import type { Tool } from "@xsai/shared-chat";
import type { Api } from "grammy";
import type { ReactionType } from "grammy/types";
import { z } from "zod";

function zodToJsonSchema(schema: z.ZodType): Record<string, unknown> {
  return z.toJSONSchema(schema, { unrepresentable: "any", io: "input" }) as Record<string, unknown>;
}

export function createMemoryTools(memory: MemoryCallbacks): Tool[] {
  return [
    {
      type: "function",
      function: {
        name: "get_profile",
        description:
          "获取某个用户的档案信息，包括备注、性格特征、兴趣爱好、关系等。当你需要回忆某个人的信息时使用。",
        parameters: zodToJsonSchema(
          z.object({
            telegram_id: z.number().describe("用户的 Telegram ID"),
          }),
        ),
      },
      execute: async (input: unknown) => {
        try {
          const { telegram_id } = input as { telegram_id: number };
          const profile = await memory.getProfile(telegram_id);
          if (!profile) return { found: false, message: "没有找到该用户的档案" };
          return { found: true, profile };
        } catch (err) {
          return { error: String(err) };
        }
      },
    },
    {
      type: "function",
      function: {
        name: "update_profile",
        description:
          "更新或创建用户档案。notes 会追加到已有备注后面，traits 和 interests 会与已有的合并去重。当你在对话中了解到用户的新信息时主动使用。",
        parameters: zodToJsonSchema(
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
      },
      execute: async (input: unknown) => {
        try {
          const data = input as {
            telegram_id: number;
            username?: string;
            display_name?: string;
            notes?: string;
            traits?: string[];
            interests?: string[];
            relationship?: string;
          };
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
    },
    {
      type: "function",
      function: {
        name: "search_profiles",
        description:
          "模糊搜索人物档案。可以按名字、用户名、备注内容、特征或兴趣搜索。当你需要找某个人但不确定其 ID 时使用。",
        parameters: zodToJsonSchema(
          z.object({
            query: z.string().describe("搜索关键词"),
          }),
        ),
      },
      execute: async (input: unknown) => {
        try {
          const { query } = input as { query: string };
          const profiles = await memory.searchProfiles(query);
          return { count: profiles.length, profiles };
        } catch (err) {
          return { error: String(err) };
        }
      },
    },
    {
      type: "function",
      function: {
        name: "search_history",
        description:
          "搜索历史对话记录。可以按关键词搜索，可选按聊天或用户过滤。当用户问「你还记得我说过…」或你需要查找之前的对话内容时使用。",
        parameters: zodToJsonSchema(
          z.object({
            query: z.string().describe("搜索关键词"),
            chat_id: z.number().optional().describe("限定在某个聊天中搜索"),
            user_id: z.number().optional().describe("限定某个用户的消息"),
            limit: z.number().optional().describe("返回结果数量上限，默认 20"),
          }),
        ),
      },
      execute: async (input: unknown) => {
        try {
          const data = input as {
            query: string;
            chat_id?: number;
            user_id?: number;
            limit?: number;
          };
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
    },
  ];
}

export interface ActionToolsOptions {
  api: Api;
  chatId: number;
  messageId: number;
  stickerCache: Map<string, string[]>;
}

export function createActionTools(options: ActionToolsOptions): Tool[] {
  const { api, chatId, messageId, stickerCache } = options;

  const tools: Tool[] = [
    {
      type: "function",
      function: {
        name: "react_to_message",
        description: "对当前用户消息添加 emoji 表情回应，如 👍 ❤️ 🔥 😂 😢 🎉 等。",
        parameters: zodToJsonSchema(
          z.object({
            emoji: z.string().describe("要添加的 emoji 表情"),
          }),
        ),
      },
      execute: async (input: unknown) => {
        try {
          const { emoji } = input as { emoji: string };
          const reaction = { type: "emoji", emoji } as unknown as ReactionType;
          await api.setMessageReaction(chatId, messageId, [reaction]);
          return { success: true };
        } catch (err) {
          return { error: String(err) };
        }
      },
    },
    {
      type: "function",
      function: {
        name: "send_sticker",
        description: "发送一个贴纸来表达情绪。提供一个 emoji 来匹配贴纸包中合适的贴纸。",
        parameters: zodToJsonSchema(
          z.object({
            emoji: z.string().describe("用于匹配贴纸的 emoji"),
          }),
        ),
      },
      execute: async (input: unknown) => {
        try {
          if (stickerCache.size === 0) {
            return { error: "no sticker packs configured" };
          }
          const { emoji } = input as { emoji: string };
          const fileIds = stickerCache.get(emoji);
          if (!fileIds || fileIds.length === 0) {
            // Fallback: pick a random sticker from any emoji
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
    },
  ];

  return tools;
}
