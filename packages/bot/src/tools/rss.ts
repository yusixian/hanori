import type { RssCollectionRecord, RssFeedRecord, RssItemRecord } from "@cos-tool-bot/shared";
import type { Tool } from "ai";
import { tool } from "ai";
import type { Api } from "grammy";
import { InlineKeyboard } from "grammy";
import { z } from "zod";
import type {
  AdminActionKind,
  PendingAdminActionRegistry,
} from "../services/pending-github-actions.js";
import { zodToAiSchema } from "./utils.js";

export interface RssToolsOptions {
  chatId: number;
  userId?: number;
  adminChatIds: number[];
  api: Api;
  pendingActions: PendingAdminActionRegistry;
  forceAdmin?: boolean;
  allowWrites?: boolean;
  onListCollections: () => Promise<RssCollectionRecord[]>;
  onGetNewItems: (
    collectionId: number,
    limit?: number,
  ) => Promise<{ collection: RssCollectionRecord; items: RssItemRecord[]; totalCount: number }>;
  onListFeeds: (collectionId: number) => Promise<RssFeedRecord[]>;
  onMarkDigested: (collectionId: number, signal?: AbortSignal) => Promise<void>;
  onAddFeed: (
    collectionId: number,
    feedUrl: string,
    signal?: AbortSignal,
  ) => Promise<RssFeedRecord>;
  onRemoveFeed: (feedId: number, signal?: AbortSignal) => Promise<void>;
  onCreateCollection: (
    params: {
      name: string;
      chatId: number;
      description?: string;
      digestHour?: number;
      digestMinute?: number;
    },
    signal?: AbortSignal,
  ) => Promise<RssCollectionRecord>;
}

export function redactRssFeedUrl(feedUrl: string): string {
  const normalizedUrl = feedUrl.trim();
  const isProtocolRelative = normalizedUrl.startsWith("//");
  try {
    const url = new URL(isProtocolRelative ? `https:${normalizedUrl}` : normalizedUrl);
    const displayPath = url.pathname === "/" ? "/" : "/…";
    const prefix = isProtocolRelative ? "//" : `${url.protocol}//`;
    const base = `${prefix}${url.host}${displayPath}`;
    return url.search ? `${base}?…` : base;
  } catch {
    return "[已隐藏的 URL]";
  }
}

function redactRssFeedTitle(title: string, feedUrl: string): string {
  const normalizedTitle = title.trim();
  if (normalizedTitle === feedUrl.trim()) {
    return redactRssFeedUrl(normalizedTitle);
  }

  const isProtocolRelative = normalizedTitle.startsWith("//");
  try {
    const url = new URL(isProtocolRelative ? `https:${normalizedTitle}` : normalizedTitle);
    if (
      url.hostname &&
      (isProtocolRelative || url.protocol === "http:" || url.protocol === "https:")
    ) {
      return redactRssFeedUrl(normalizedTitle);
    }
  } catch {
    return title;
  }
  return title;
}

export function createRssTools(options: RssToolsOptions): Record<string, Tool> {
  const { chatId, userId, adminChatIds } = options;
  const requesterIsAdmin = userId != null && adminChatIds.includes(userId);
  const canListFeeds = options.forceAdmin || requesterIsAdmin;
  const canWrite = requesterIsAdmin && options.allowWrites !== false;

  async function proposeAction(
    kind: Exclude<AdminActionKind, "github">,
    description: string,
    execute: (signal?: AbortSignal) => Promise<{ summary: string }>,
  ) {
    if (userId == null) throw new Error("RSS write confirmation requires an administrator");
    const pending = options.pendingActions.register({
      kind,
      chatId,
      userId,
      description,
      execute,
    });
    const keyboard = new InlineKeyboard()
      .text("确认执行", `cos:rss:${pending.id}:yes`)
      .text("取消", `cos:rss:${pending.id}:no`);
    try {
      await options.api.sendMessage(
        chatId,
        `🔐 RSS 管理员确认\n\n${description}\n\n此请求 10 分钟后过期。`,
        { reply_markup: keyboard },
      );
    } catch (error) {
      options.pendingActions.remove(pending.id);
      throw error;
    }
    return { pending_confirmation: true, action_id: pending.id, description };
  }

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

  if (canListFeeds) {
    tools.list_rss_feeds = tool({
      description:
        "列出指定 RSS 合集中的订阅源，包括可用于 remove_rss_feed 的 Feed ID、标题和脱敏 URL。",
      inputSchema: zodToAiSchema(
        z.object({
          collection_id: z.number().describe("合集 ID"),
        }),
      ),
      execute: async ({ collection_id }) => {
        try {
          const feeds = await options.onListFeeds(collection_id);
          return {
            feeds: feeds.map((feed) => ({
              id: feed.id,
              title: redactRssFeedTitle(feed.title, feed.feedUrl),
              feedUrl: redactRssFeedUrl(feed.feedUrl),
            })),
          };
        } catch (err) {
          return { error: String(err) };
        }
      },
    });
  }

  // Admin-only tools
  if (canWrite) {
    tools.mark_rss_read = tool({
      description: "申请标记某个 RSS 合集的所有未读条目为已读；发送管理员确认按钮，确认后才执行。",
      inputSchema: zodToAiSchema(
        z.object({
          collection_id: z.number().describe("合集 ID"),
        }),
      ),
      execute: async ({ collection_id }) => {
        try {
          return await proposeAction(
            "rss:mark_rss_read",
            `标记 RSS 合集 ${collection_id} 的所有未读条目为已读`,
            async (signal) => {
              signal?.throwIfAborted();
              await options.onMarkDigested(collection_id, signal);
              return { summary: `已标记 RSS 合集 ${collection_id} 为已读` };
            },
          );
        } catch (err) {
          return { error: String(err) };
        }
      },
    });

    tools.add_rss_feed = tool({
      description: "申请向指定 RSS 合集添加订阅源；发送管理员确认按钮，确认后才执行。",
      inputSchema: zodToAiSchema(
        z.object({
          collection_id: z.number().describe("合集 ID"),
          feed_url: z.string().describe("RSS/Atom feed URL"),
        }),
      ),
      execute: async ({ collection_id, feed_url }) => {
        try {
          const displayUrl = redactRssFeedUrl(feed_url);
          return await proposeAction(
            "rss:add_rss_feed",
            `向 RSS 合集 ${collection_id} 添加订阅源：${displayUrl}`,
            async (signal) => {
              signal?.throwIfAborted();
              await options.onAddFeed(collection_id, feed_url, signal);
              return { summary: `已向 RSS 合集 ${collection_id} 添加订阅源：${displayUrl}` };
            },
          );
        } catch (err) {
          return { error: String(err) };
        }
      },
    });

    tools.remove_rss_feed = tool({
      description: "申请从合集中移除订阅源；发送管理员确认按钮，确认后才执行。",
      inputSchema: zodToAiSchema(
        z.object({
          feed_id: z.number().describe("Feed ID"),
        }),
      ),
      execute: async ({ feed_id }) => {
        try {
          return await proposeAction(
            "rss:remove_rss_feed",
            `移除 RSS 订阅源 ${feed_id}`,
            async (signal) => {
              signal?.throwIfAborted();
              await options.onRemoveFeed(feed_id, signal);
              return { summary: `已移除 RSS 订阅源 ${feed_id}` };
            },
          );
        } catch (err) {
          return { error: String(err) };
        }
      },
    });

    tools.create_rss_collection = tool({
      description:
        "申请创建 RSS 合集；发送管理员确认按钮，确认后才执行。合集会按指定时间触发 AI 总结。",
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
          const params = {
            name,
            chatId,
            description,
            digestHour: digest_hour,
            digestMinute: digest_minute,
          };
          const schedule = `${digest_hour ?? 9}:${String(digest_minute ?? 0).padStart(2, "0")} UTC`;
          return await proposeAction(
            "rss:create_rss_collection",
            `在当前聊天创建 RSS 合集「${name}」（推送时间 ${schedule}）`,
            async (signal) => {
              signal?.throwIfAborted();
              await options.onCreateCollection(params, signal);
              return { summary: `已创建 RSS 合集「${name}」` };
            },
          );
        } catch (err) {
          return { error: String(err) };
        }
      },
    });
  }

  return tools;
}
