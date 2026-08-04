import type { RssCollectionRecord, RssFeedRecord } from "@cos-tool-bot/shared";
import { describe, expect, it, vi } from "vitest";
import { BotPool } from "./bot-pool.js";
import type { RssFeedService } from "./rss-feed-service.js";

vi.mock("../env.js", () => ({
  env: { ENCRYPTION_KEY: "test-key" },
}));

const BOT_A = "00000000-0000-4000-8000-000000000001";
const BOT_B = "00000000-0000-4000-8000-000000000002";

interface RssCallbacks {
  onGetNewItems: (
    collectionId: number,
    limit?: number,
  ) => Promise<{ collection: RssCollectionRecord; items: unknown[]; totalCount: number }>;
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

interface RssPoolInternals {
  rssFeedService: RssFeedService;
  buildRssCallbacks: (botId: string) => RssCallbacks;
}

function collection(botId: string): RssCollectionRecord {
  return {
    id: 7,
    botId,
    chatId: -1001,
    name: "Frontend",
    description: null,
    digestPrompt: null,
    isActive: true,
    digestHour: 9,
    digestMinute: 0,
    maxDigestItems: null,
    lastDigestAt: null,
    createdAt: "2026-08-01T00:00:00.000Z",
    updatedAt: null,
  };
}

function createCallbacks(ownerBotId: string | null, feedExists = true) {
  const feeds = [
    {
      id: 21,
      collectionId: 7,
      feedUrl: "https://example.com/feed.xml",
      title: "Example feed",
      maxDigestItems: null,
      lastFetchAt: null,
      createdAt: "2026-08-01T00:00:00.000Z",
    },
  ] satisfies RssFeedRecord[];
  const getCollection = vi.fn().mockResolvedValue(ownerBotId ? collection(ownerBotId) : null);
  const listFeeds = vi.fn().mockResolvedValue(feeds);
  const getFeed = vi.fn().mockResolvedValue(feedExists ? feeds[0] : null);
  const getUndigestedItems = vi.fn().mockResolvedValue({ items: [], totalCount: 0 });
  const markDigested = vi.fn().mockResolvedValue(1);
  const addFeed = vi.fn().mockResolvedValue(feeds[0]);
  const removeFeed = vi.fn().mockResolvedValue(true);
  const createCollection = vi
    .fn()
    .mockImplementation((params: { botId: string }) => Promise.resolve(collection(params.botId)));
  const pool = Object.create(BotPool.prototype) as RssPoolInternals;
  pool.rssFeedService = {
    getCollection,
    listFeeds,
    getFeed,
    getUndigestedItems,
    markDigested,
    addFeed,
    removeFeed,
    createCollection,
  } as unknown as RssFeedService;
  return {
    callbacks: pool.buildRssCallbacks(BOT_A),
    feeds,
    getCollection,
    listFeeds,
    getFeed,
    getUndigestedItems,
    markDigested,
    addFeed,
    removeFeed,
    createCollection,
  };
}

describe("BotPool RSS callback tenant scope", () => {
  it("lists feeds when the collection belongs to the requesting Bot", async () => {
    const { callbacks, feeds, getCollection, listFeeds } = createCallbacks(BOT_A);

    await expect(callbacks.onListFeeds(7)).resolves.toEqual(feeds);
    expect(getCollection).toHaveBeenCalledWith(7);
    expect(listFeeds).toHaveBeenCalledWith(7);
  });

  it.each([
    { name: "missing", ownerBotId: null },
    { name: "owned by another Bot", ownerBotId: BOT_B },
  ])("rejects a $name collection without listing its feeds", async ({ ownerBotId }) => {
    const { callbacks, listFeeds } = createCallbacks(ownerBotId);

    await expect(callbacks.onListFeeds(7)).rejects.toThrow("Collection not found");
    expect(listFeeds).not.toHaveBeenCalled();
  });

  it("checks collection ownership before loading unread items", async () => {
    const owned = createCallbacks(BOT_A);
    await expect(owned.callbacks.onGetNewItems(7, 30)).resolves.toMatchObject({
      collection: { id: 7, botId: BOT_A },
      items: [],
      totalCount: 0,
    });
    expect(owned.getUndigestedItems).toHaveBeenCalledWith(7, 30);

    const foreign = createCallbacks(BOT_B);
    await expect(foreign.callbacks.onGetNewItems(7, 30)).rejects.toThrow("Collection not found");
    expect(foreign.getUndigestedItems).not.toHaveBeenCalled();
  });

  it("revalidates Bot ownership for mark, add and remove at execution time", async () => {
    const { callbacks, markDigested, addFeed, removeFeed, getFeed } = createCallbacks(BOT_A);
    const signal = new AbortController().signal;

    await expect(callbacks.onMarkDigested(7, signal)).resolves.toBeUndefined();
    await expect(
      callbacks.onAddFeed(7, "https://example.com/feed.xml", signal),
    ).resolves.toMatchObject({ id: 21 });
    await expect(callbacks.onRemoveFeed(21, signal)).resolves.toBeUndefined();
    expect(markDigested).toHaveBeenCalledWith(7, signal);
    expect(addFeed).toHaveBeenCalledWith(
      7,
      "https://example.com/feed.xml",
      undefined,
      undefined,
      signal,
    );
    expect(getFeed).toHaveBeenCalledWith(21);
    expect(removeFeed).toHaveBeenCalledWith(21, 7, signal);
  });

  it("does not mutate mark, add or remove for another Bot's collection", async () => {
    const { callbacks, markDigested, addFeed, removeFeed } = createCallbacks(BOT_B);

    await expect(callbacks.onMarkDigested(7)).rejects.toThrow("Collection not found");
    await expect(callbacks.onAddFeed(7, "https://example.com/feed.xml")).rejects.toThrow(
      "Collection not found",
    );
    await expect(callbacks.onRemoveFeed(21)).rejects.toThrow("Collection not found");
    expect(markDigested).not.toHaveBeenCalled();
    expect(addFeed).not.toHaveBeenCalled();
    expect(removeFeed).not.toHaveBeenCalled();
  });

  it("does not remove a missing feed", async () => {
    const { callbacks, removeFeed } = createCallbacks(BOT_A, false);

    await expect(callbacks.onRemoveFeed(404)).rejects.toThrow("Feed 404 not found");
    expect(removeFeed).not.toHaveBeenCalled();
  });

  it("binds collection creation to the current Bot and chat", async () => {
    const { callbacks, createCollection } = createCallbacks(BOT_A);
    const signal = new AbortController().signal;

    await callbacks.onCreateCollection(
      {
        name: "Frontend",
        chatId: -100,
        description: "Focus",
        digestHour: 8,
        digestMinute: 30,
      },
      signal,
    );
    expect(createCollection).toHaveBeenCalledWith(
      {
        botId: BOT_A,
        name: "Frontend",
        chatId: -100,
        description: "Focus",
        digestHour: 8,
        digestMinute: 30,
      },
      signal,
    );
  });

  it("stops after ownership validation when an RSS mutation is aborted", async () => {
    const { callbacks, getCollection, addFeed } = createCallbacks(BOT_A);
    const controller = new AbortController();
    getCollection.mockImplementationOnce(async () => {
      controller.abort(new Error("RSS mutation cancelled"));
      return collection(BOT_A);
    });

    await expect(
      callbacks.onAddFeed(7, "https://example.com/feed.xml", controller.signal),
    ).rejects.toThrow("RSS mutation cancelled");
    expect(addFeed).not.toHaveBeenCalled();
  });
});
