import type { RssFeedService } from "../rss-feed-service.js";

export function createRssCallbacks(botId: string, rss: RssFeedService) {
  const requireCollection = async (collectionId: number, signal?: AbortSignal) => {
    signal?.throwIfAborted();
    const collection = await rss.getCollection(collectionId);
    if (!collection || collection.botId !== botId) throw new Error("Collection not found");
    signal?.throwIfAborted();
    return collection;
  };
  return {
    onListCollections: () => rss.listCollections(botId),
    onGetNewItems: async (collectionId: number, limit?: number) => {
      const collection = await requireCollection(collectionId);
      const { items, totalCount } = await rss.getUndigestedItems(collectionId, limit);
      return { collection, items, totalCount };
    },
    onListFeeds: async (collectionId: number) => {
      await requireCollection(collectionId);
      return rss.listFeeds(collectionId);
    },
    onMarkDigested: async (collectionId: number, signal?: AbortSignal) => {
      await requireCollection(collectionId, signal);
      signal?.throwIfAborted();
      await rss.markDigested(collectionId, signal);
    },
    onAddFeed: async (collectionId: number, feedUrl: string, signal?: AbortSignal) => {
      await requireCollection(collectionId, signal);
      signal?.throwIfAborted();
      return rss.addFeed(collectionId, feedUrl, undefined, undefined, signal);
    },
    onRemoveFeed: async (feedId: number, signal?: AbortSignal) => {
      signal?.throwIfAborted();
      const feed = await rss.getFeed(feedId);
      if (!feed) throw new Error(`Feed ${feedId} not found`);
      await requireCollection(feed.collectionId, signal);
      signal?.throwIfAborted();
      const ok = await rss.removeFeed(feedId, feed.collectionId, signal);
      if (!ok) throw new Error(`Feed ${feedId} not found`);
    },
    onCreateCollection: async (
      params: {
        name: string;
        chatId: number;
        description?: string;
        digestHour?: number;
        digestMinute?: number;
      },
      signal?: AbortSignal,
    ) => {
      signal?.throwIfAborted();
      return rss.createCollection({ botId, ...params }, signal);
    },
  };
}
