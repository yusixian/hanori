import type { RssCollectionRecord, RssFeedRecord, RssItemRecord } from "@cos-tool-bot/shared";
import type { Tool } from "ai";
import { tool } from "ai";
import { z } from "zod";
import { zodToAiSchema } from "./utils.js";

export interface RssToolsOptions {
  chatId: number;
  adminChatIds: number[];
  forceAdmin?: boolean;
  onListCollections: () => Promise<RssCollectionRecord[]>;
  onGetNewItems: (
    collectionId: number,
    limit?: number,
  ) => Promise<{ collection: RssCollectionRecord; items: RssItemRecord[]; totalCount: number }>;
  onMarkDigested: (collectionId: number) => Promise<void>;
  onAddFeed: (collectionId: number, feedUrl: string) => Promise<RssFeedRecord>;
  onRemoveFeed: (feedId: number) => Promise<void>;
  onCreateCollection: (params: {
    name: string;
    chatId: number;
    description?: string;
    digestHour?: number;
    digestMinute?: number;
  }) => Promise<RssCollectionRecord>;
}

export function createRssTools(options: RssToolsOptions): Record<string, Tool> {
  const { chatId, adminChatIds } = options;
  const isAdmin = options.forceAdmin || adminChatIds.includes(chatId);

  const tools: Record<string, Tool> = {
    check_rss: tool({
      description:
        "查看 RSS 合集列表和最新未读条目。不指定 collection_id 时列出所有合集，指定时返回该合集的未读条目。",
      inputSchema: zodToAiSchema(
        z.object({
          collection_id: z.number().optional().describe("合集 ID，不传则列出所有合集"),
          limit: z.number().optional().describe("返回条目数量上限，默认 30"),
        }),
      ),
      execute: async ({ collection_id, limit }) => {
        try {
          if (collection_id == null) {
            const collections = await options.onListCollections();
            return { collections };
          }
          const result = await options.onGetNewItems(collection_id, limit ?? 30);
          return {
            collection: result.collection,
            totalCount: result.totalCount,
            items: result.items.map((item) => ({
              id: item.id,
              title: item.title,
              link: item.link,
              summary: item.summary,
              publishedAt: item.publishedAt,
            })),
          };
        } catch (err) {
          return { error: String(err) };
        }
      },
    }),
  };

  // Admin-only tools
  if (isAdmin) {
    tools.mark_rss_read = tool({
      description:
        "标记某个 RSS 合集的所有未读条目为已读。完成 RSS 摘要后必须调用此工具确认已处理。",
      inputSchema: zodToAiSchema(
        z.object({
          collection_id: z.number().describe("合集 ID"),
        }),
      ),
      execute: async ({ collection_id }) => {
        try {
          await options.onMarkDigested(collection_id);
          return { success: true };
        } catch (err) {
          return { error: String(err) };
        }
      },
    });

    tools.add_rss_feed = tool({
      description: "向指定 RSS 合集添加一条新的 feed 订阅源。",
      inputSchema: zodToAiSchema(
        z.object({
          collection_id: z.number().describe("合集 ID"),
          feed_url: z.string().describe("RSS/Atom feed URL"),
        }),
      ),
      execute: async ({ collection_id, feed_url }) => {
        try {
          const feed = await options.onAddFeed(collection_id, feed_url);
          return { success: true, feed };
        } catch (err) {
          return { error: String(err) };
        }
      },
    });

    tools.remove_rss_feed = tool({
      description: "从合集中移除一条 feed 订阅源。",
      inputSchema: zodToAiSchema(
        z.object({
          feed_id: z.number().describe("Feed ID"),
        }),
      ),
      execute: async ({ feed_id }) => {
        try {
          await options.onRemoveFeed(feed_id);
          return { success: true };
        } catch (err) {
          return { error: String(err) };
        }
      },
    });

    tools.create_rss_collection = tool({
      description:
        "创建一个新的 RSS 合集。合集用于将多条 feed 归组，到达指定时间时会触发 AI 总结。",
      inputSchema: zodToAiSchema(
        z.object({
          name: z.string().describe("合集名称"),
          description: z.string().optional().describe("AI 总结时的引导描述"),
          digest_hour: z
            .number()
            .min(0)
            .max(23)
            .optional()
            .describe("推送时间的小时部分（UTC 0-23），默认 9"),
          digest_minute: z
            .number()
            .min(0)
            .max(59)
            .optional()
            .describe("推送时间的分钟部分（0-59），默认 0"),
        }),
      ),
      execute: async ({ name, description, digest_hour, digest_minute }) => {
        try {
          const collection = await options.onCreateCollection({
            name,
            chatId,
            description,
            digestHour: digest_hour,
            digestMinute: digest_minute,
          });
          return { success: true, collection };
        } catch (err) {
          return { error: String(err) };
        }
      },
    });
  }

  return tools;
}
