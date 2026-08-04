import type { RssFeedRecord } from "@cos-tool-bot/shared";
import type { Api } from "grammy";
import { describe, expect, it, vi } from "vitest";
import { PendingAdminActionRegistry } from "../services/pending-github-actions.js";
import { createRssTools, type RssToolsOptions } from "./rss.js";

function createOptions(overrides: Partial<RssToolsOptions> = {}): RssToolsOptions {
  return {
    chatId: 123,
    adminChatIds: [],
    api: { sendMessage: vi.fn().mockResolvedValue({ message_id: 1 }) } as unknown as Api,
    pendingActions: new PendingAdminActionRegistry(),
    onListCollections: vi.fn(),
    onGetNewItems: vi.fn(),
    onListFeeds: vi.fn(),
    onMarkDigested: vi.fn(),
    onAddFeed: vi.fn(),
    onRemoveFeed: vi.fn(),
    onCreateCollection: vi.fn(),
    ...overrides,
  };
}

describe("createRssTools", () => {
  it("lists feed identifiers, titles, and URLs for a collection", async () => {
    const feeds = [
      {
        id: 21,
        collectionId: 7,
        feedUrl: "https://reader:password@example.com/feed.xml?token=secret",
        title: "Example feed",
        maxDigestItems: 10,
        lastFetchAt: "2026-08-05T00:00:00.000Z",
        createdAt: "2026-08-01T00:00:00.000Z",
      },
      {
        id: 22,
        collectionId: 7,
        feedUrl: "https://reader:password@example.com/feed.xml?token=secret",
        title: "https://reader:password@example.com/feed.xml?token=secret",
        maxDigestItems: 10,
        lastFetchAt: null,
        createdAt: "2026-08-01T00:00:00.000Z",
      },
      {
        id: 23,
        collectionId: 7,
        feedUrl: "https://example.com/feed.xml",
        title: "https://other-user:other-password@other.example/private.xml?api_key=other-token",
        maxDigestItems: 10,
        lastFetchAt: null,
        createdAt: "2026-08-01T00:00:00.000Z",
      },
      {
        id: 24,
        collectionId: 7,
        feedUrl: "https://example.com/news.xml",
        title: "News: daily digest",
        maxDigestItems: 10,
        lastFetchAt: null,
        createdAt: "2026-08-01T00:00:00.000Z",
      },
      {
        id: 25,
        collectionId: 7,
        feedUrl: "https://example.com/css.xml",
        title: "CSS: The Definitive Guide",
        maxDigestItems: 10,
        lastFetchAt: null,
        createdAt: "2026-08-01T00:00:00.000Z",
      },
      {
        id: 26,
        collectionId: 7,
        feedUrl: "https://example.com/protocol-relative.xml",
        title: "//reader:password@other.example/private.xml?token=secret",
        maxDigestItems: 10,
        lastFetchAt: null,
        createdAt: "2026-08-01T00:00:00.000Z",
      },
    ] satisfies RssFeedRecord[];
    const onListFeeds = vi.fn().mockResolvedValue(feeds);
    const tools = createRssTools(
      createOptions({ chatId: -100, userId: 123, adminChatIds: [123], onListFeeds }),
    );

    await expect(
      tools.list_rss_feeds!.execute!({ collection_id: 7 }, {} as never),
    ).resolves.toEqual({
      feeds: [
        {
          id: 21,
          title: "Example feed",
          feedUrl: "https://example.com/…?…",
        },
        {
          id: 22,
          title: "https://example.com/…?…",
          feedUrl: "https://example.com/…?…",
        },
        {
          id: 23,
          title: "https://other.example/…?…",
          feedUrl: "https://example.com/…",
        },
        {
          id: 24,
          title: "News: daily digest",
          feedUrl: "https://example.com/…",
        },
        {
          id: 25,
          title: "CSS: The Definitive Guide",
          feedUrl: "https://example.com/…",
        },
        {
          id: 26,
          title: "//other.example/…?…",
          feedUrl: "https://example.com/…",
        },
      ],
    });
    expect(onListFeeds).toHaveBeenCalledWith(7);
  });

  it("returns callback failures through the existing RSS tool error payload", async () => {
    const tools = createRssTools(
      createOptions({
        chatId: -100,
        userId: 123,
        adminChatIds: [123],
        onListFeeds: vi.fn().mockRejectedValue(new Error("Collection not found")),
      }),
    );

    await expect(
      tools.list_rss_feeds!.execute!({ collection_id: 404 }, {} as never),
    ).resolves.toEqual({ error: "Error: Collection not found" });
  });

  it("uses the requester identity for RSS admin tools in a group chat", () => {
    const adminTools = createRssTools(
      createOptions({ chatId: -100, userId: 123, adminChatIds: [123] }),
    );
    const memberTools = createRssTools(
      createOptions({ chatId: -100, userId: 456, adminChatIds: [123] }),
    );

    expect(adminTools.list_rss_feeds).toBeDefined();
    expect(adminTools.mark_rss_read).toBeDefined();
    expect(adminTools.add_rss_feed).toBeDefined();
    expect(adminTools.remove_rss_feed).toBeDefined();
    expect(adminTools.create_rss_collection).toBeDefined();
    expect(memberTools.check_rss).toBeDefined();
    expect(memberTools.list_rss_feeds).toBeUndefined();
    expect(memberTools.mark_rss_read).toBeUndefined();
    expect(memberTools.add_rss_feed).toBeUndefined();
    expect(memberTools.remove_rss_feed).toBeUndefined();
    expect(memberTools.create_rss_collection).toBeUndefined();
  });

  it("queues every RSS mutation with exact arguments and performs no immediate writes", async () => {
    const registry = new PendingAdminActionRegistry();
    const sendMessage = vi.fn().mockResolvedValue({ message_id: 1 });
    const api = { sendMessage } as unknown as Api;
    const onMarkDigested = vi.fn().mockResolvedValue(undefined);
    const onAddFeed = vi.fn().mockResolvedValue({ id: 22 });
    const onRemoveFeed = vi.fn().mockResolvedValue(undefined);
    const onCreateCollection = vi.fn().mockResolvedValue({ id: 8 });
    const tools = createRssTools(
      createOptions({
        chatId: -100,
        userId: 123,
        adminChatIds: [123],
        api,
        pendingActions: registry,
        onMarkDigested,
        onAddFeed,
        onRemoveFeed,
        onCreateCollection,
      }),
    );
    const secretUrl = "https://reader:password@example.com/feed.xml?token=secret";
    const calls = [
      [tools.mark_rss_read, { collection_id: 7 }, "rss:mark_rss_read"],
      [tools.add_rss_feed, { collection_id: 7, feed_url: secretUrl }, "rss:add_rss_feed"],
      [tools.remove_rss_feed, { feed_id: 22 }, "rss:remove_rss_feed"],
      [
        tools.create_rss_collection,
        { name: "Frontend", description: "Focus", digest_hour: 8, digest_minute: 30 },
        "rss:create_rss_collection",
      ],
    ] as const;

    const pendingIds: string[] = [];
    for (const [rssTool, input, kind] of calls) {
      const result = (await rssTool!.execute!(input, {} as never)) as {
        pending_confirmation: boolean;
        action_id: string;
        description: string;
      };
      expect(result.pending_confirmation).toBe(true);
      expect(result.description).not.toContain("password");
      expect(result.description).not.toContain("secret");
      const action = registry.get(result.action_id);
      expect(action).toMatchObject({ kind, chatId: -100, userId: 123 });
      pendingIds.push(result.action_id);
    }

    expect(onMarkDigested).not.toHaveBeenCalled();
    expect(onAddFeed).not.toHaveBeenCalled();
    expect(onRemoveFeed).not.toHaveBeenCalled();
    expect(onCreateCollection).not.toHaveBeenCalled();
    expect(JSON.stringify(sendMessage.mock.calls)).not.toContain("password");
    expect(JSON.stringify(sendMessage.mock.calls)).not.toContain("secret");

    const actionResults = [];
    for (const id of pendingIds) {
      const action = registry.take(id);
      expect(action).toBeDefined();
      actionResults.push(await registry.run(action!));
    }
    expect(JSON.stringify(actionResults)).not.toContain("password");
    expect(JSON.stringify(actionResults)).not.toContain("secret");
    expect(onMarkDigested).toHaveBeenCalledWith(7, expect.any(AbortSignal));
    expect(onAddFeed).toHaveBeenCalledWith(7, secretUrl, expect.any(AbortSignal));
    expect(onRemoveFeed).toHaveBeenCalledWith(22, expect.any(AbortSignal));
    expect(onCreateCollection).toHaveBeenCalledWith(
      {
        name: "Frontend",
        chatId: -100,
        description: "Focus",
        digestHour: 8,
        digestMinute: 30,
      },
      expect.any(AbortSignal),
    );
    registry.destroy();
  });

  it("removes a pending RSS action when sending its confirmation fails", async () => {
    const registry = new PendingAdminActionRegistry();
    const register = vi.spyOn(registry, "register");
    const tools = createRssTools(
      createOptions({
        chatId: -100,
        userId: 123,
        adminChatIds: [123],
        api: {
          sendMessage: vi.fn().mockRejectedValue(new Error("Telegram unavailable")),
        } as unknown as Api,
        pendingActions: registry,
      }),
    );

    await expect(tools.remove_rss_feed!.execute!({ feed_id: 22 }, {} as never)).resolves.toEqual({
      error: "Error: Telegram unavailable",
    });
    const registered = register.mock.results[0]?.value;
    expect(registered).toBeDefined();
    expect(registry.get(registered!.id)).toBeUndefined();
    registry.destroy();
  });

  it("reports success when an abort arrives after a mutation has completed", async () => {
    const registry = new PendingAdminActionRegistry();
    const onRemoveFeed = vi.fn().mockImplementation(async () => {
      registry.destroy();
    });
    const tools = createRssTools(
      createOptions({
        chatId: -100,
        userId: 123,
        adminChatIds: [123],
        pendingActions: registry,
        onRemoveFeed,
      }),
    );
    const pending = (await tools.remove_rss_feed!.execute!({ feed_id: 22 }, {} as never)) as {
      action_id: string;
    };
    const action = registry.take(pending.action_id);

    await expect(registry.run(action!)).resolves.toEqual({ summary: "已移除 RSS 订阅源 22" });
    expect(onRemoveFeed).toHaveBeenCalledWith(22, expect.any(AbortSignal));
  });

  it("aborts a deferred add callback before its final insert boundary", async () => {
    const registry = new PendingAdminActionRegistry();
    let releaseParse!: () => void;
    const parsed = new Promise<void>((resolve) => {
      releaseParse = resolve;
    });
    let started!: () => void;
    const didStart = new Promise<void>((resolve) => {
      started = resolve;
    });
    const insert = vi.fn();
    const onAddFeed = vi.fn(
      async (_collectionId: number, _feedUrl: string, signal?: AbortSignal) => {
        started();
        await parsed;
        signal?.throwIfAborted();
        insert();
        return { id: 22 } as RssFeedRecord;
      },
    );
    const tools = createRssTools(
      createOptions({
        chatId: -100,
        userId: 123,
        adminChatIds: [123],
        pendingActions: registry,
        onAddFeed,
      }),
    );
    const pending = (await tools.add_rss_feed!.execute!(
      { collection_id: 7, feed_url: "https://example.com/feed.xml" },
      {} as never,
    )) as { action_id: string };
    const action = registry.take(pending.action_id);
    const run = registry.run(action!);
    const runResult = expect(run).rejects.toThrow("Admin action registry was destroyed");
    await didStart;

    registry.destroy();
    releaseParse();

    await runResult;
    await expect(registry.drain()).resolves.toEqual({ settled: true, timedOut: false });
    expect(insert).not.toHaveBeenCalled();
  });

  it("exposes only read-only RSS tools to a trusted forced-admin run", () => {
    const tools = createRssTools(
      createOptions({ chatId: 123, adminChatIds: [], forceAdmin: true, allowWrites: true }),
    );
    const forcedMemberTools = createRssTools(
      createOptions({
        chatId: -100,
        userId: 456,
        adminChatIds: [123],
        forceAdmin: true,
        allowWrites: true,
      }),
    );

    expect(tools.check_rss).toBeDefined();
    expect(tools.list_rss_feeds).toBeDefined();
    expect(tools.mark_rss_read).toBeUndefined();
    expect(tools.add_rss_feed).toBeUndefined();
    expect(tools.remove_rss_feed).toBeUndefined();
    expect(tools.create_rss_collection).toBeUndefined();
    expect(forcedMemberTools.list_rss_feeds).toBeDefined();
    expect(forcedMemberTools.mark_rss_read).toBeUndefined();
    expect(forcedMemberTools.add_rss_feed).toBeUndefined();
    expect(forcedMemberTools.remove_rss_feed).toBeUndefined();
    expect(forcedMemberTools.create_rss_collection).toBeUndefined();
  });
});
