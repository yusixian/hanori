import type { Database } from "@cos-tool-bot/database";
import { rssCollections, rssFeeds, rssItems } from "@cos-tool-bot/database";
import type { RssCollectionRecord, RssFeedRecord, RssItemRecord } from "@cos-tool-bot/shared";
import { and, desc, eq, isNotNull, isNull, lt, inArray, sql } from "drizzle-orm";
import type { Logger } from "pino";
import Parser from "rss-parser";
import {
  buildDigestEventDescription,
  mapCollectionRecord,
  mapFeedRecord,
  mapItemRecord,
  pooledMap,
  type TruncatedFeedInfo,
} from "./rss-feed-helpers.js";

const POLL_INTERVAL_MS = 30 * 60 * 1000; // 30 minutes
const DIGEST_CHECK_INTERVAL_MS = 60 * 1000; // 1 minute
const FETCH_TIMEOUT_MS = 15_000;
const MAX_CONCURRENT_FETCHES = 5;
const MAX_SUMMARY_LENGTH = 500;
const CLEANUP_DAYS = 30;

export type RssDigestTrigger = (botId: string, chatId: number, eventDescription: string) => boolean;

export class RssFeedService {
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private digestTimer: ReturnType<typeof setInterval> | null = null;
  private parser = new Parser({ timeout: FETCH_TIMEOUT_MS });
  private onDigestTrigger?: RssDigestTrigger;
  private lastCleanupAt = 0;
  private digestInFlight = new Set<number>();

  constructor(
    private db: Database,
    private logger: Logger,
  ) {}

  setDigestTrigger(fn: RssDigestTrigger) {
    this.onDigestTrigger = fn;
  }

  start() {
    this.pollTimer = setInterval(() => {
      this.pollAllFeeds().catch((err) => {
        this.logger.error(err, "RSS poll cycle failed");
      });
    }, POLL_INTERVAL_MS);
    this.pollTimer.unref();

    this.digestTimer = setInterval(() => {
      this.checkDigests().catch((err) => {
        this.logger.error(err, "RSS digest check failed");
      });
    }, DIGEST_CHECK_INTERVAL_MS);
    this.digestTimer.unref();

    // Initial poll after a short delay
    setTimeout(() => {
      this.pollAllFeeds().catch((err) => {
        this.logger.error(err, "RSS initial poll failed");
      });
    }, 5000);

    this.logger.info("RSS feed service started");
  }

  stop() {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    if (this.digestTimer) {
      clearInterval(this.digestTimer);
      this.digestTimer = null;
    }
    this.logger.info("RSS feed service stopped");
  }

  // ── Polling ──

  async pollAllFeeds() {
    const activeCollections = await this.db
      .select({ id: rssCollections.id })
      .from(rssCollections)
      .where(eq(rssCollections.isActive, true));

    if (activeCollections.length === 0) return;

    const feeds = await this.db
      .select()
      .from(rssFeeds)
      .where(
        inArray(
          rssFeeds.collectionId,
          activeCollections.map((c) => c.id),
        ),
      );

    const results = await pooledMap(feeds, (feed) => this.fetchFeed(feed), MAX_CONCURRENT_FETCHES);
    const totalNew = results.reduce((sum, n) => sum + n, 0);

    if (totalNew > 0) {
      this.logger.info(`RSS poll: ${totalNew} new items from ${feeds.length} feeds`);
    }

    // Cleanup old digested items (at most once per day)
    if (Date.now() - this.lastCleanupAt > 24 * 60 * 60 * 1000) {
      try {
        const cutoff = new Date(Date.now() - CLEANUP_DAYS * 24 * 60 * 60 * 1000);
        await this.db
          .delete(rssItems)
          .where(and(isNotNull(rssItems.digestedAt), lt(rssItems.digestedAt, cutoff)));
      } catch (err) {
        this.logger.warn(err, "RSS cleanup failed");
      }
      this.lastCleanupAt = Date.now();
    }
  }

  async pollCollection(collectionId: number) {
    const feeds = await this.db
      .select()
      .from(rssFeeds)
      .where(eq(rssFeeds.collectionId, collectionId));

    const results = await pooledMap(feeds, (feed) => this.fetchFeed(feed), MAX_CONCURRENT_FETCHES);
    return results.reduce((sum, n) => sum + n, 0);
  }

  private async fetchFeed(feed: typeof rssFeeds.$inferSelect): Promise<number> {
    try {
      const result = await this.parser.parseURL(feed.feedUrl);

      const toInsert = result.items
        .map((item) => {
          const guid = item.guid || item.link || item.title || "";
          if (!guid) return null;
          return {
            feedId: feed.id,
            guid,
            title: item.title ?? "Untitled",
            link: item.link ?? "",
            summary: item.contentSnippet?.slice(0, MAX_SUMMARY_LENGTH) ?? null,
            publishedAt: item.isoDate ? new Date(item.isoDate) : null,
          };
        })
        .filter((v): v is NonNullable<typeof v> => v !== null);

      let newCount = 0;
      if (toInsert.length > 0) {
        const inserted = await this.db
          .insert(rssItems)
          .values(toInsert)
          .onConflictDoNothing()
          .returning({ id: rssItems.id });
        newCount = inserted.length;
      }

      await this.db
        .update(rssFeeds)
        .set({ lastFetchAt: new Date() })
        .where(eq(rssFeeds.id, feed.id));

      return newCount;
    } catch (err) {
      this.logger.warn(
        { feedId: feed.id, url: feed.feedUrl, error: String(err) },
        "RSS feed fetch failed",
      );
      return 0;
    }
  }

  // ── Digest ──

  private async checkDigests() {
    if (!this.onDigestTrigger) return;

    const now = new Date();
    const currentHour = now.getUTCHours();
    const currentMinute = now.getUTCMinutes();
    const twentyThreeHoursAgo = new Date(now.getTime() - 23 * 60 * 60 * 1000);

    const collections = await this.db
      .select()
      .from(rssCollections)
      .where(
        and(
          eq(rssCollections.isActive, true),
          eq(rssCollections.digestHour, currentHour),
          eq(rssCollections.digestMinute, currentMinute),
        ),
      );

    for (const collection of collections) {
      if (collection.lastDigestAt && collection.lastDigestAt > twentyThreeHoursAgo) {
        continue;
      }
      await this.triggerDigest(collection.id);
    }
  }

  async triggerDigest(collectionId: number): Promise<boolean> {
    if (!this.onDigestTrigger) return false;
    if (this.digestInFlight.has(collectionId)) return false;
    this.digestInFlight.add(collectionId);
    try {
      return await this.triggerDigestOnce(collectionId);
    } finally {
      this.digestInFlight.delete(collectionId);
    }
  }

  private async triggerDigestOnce(collectionId: number): Promise<boolean> {
    if (!this.onDigestTrigger) return false;

    const [collection] = await this.db
      .select()
      .from(rssCollections)
      .where(eq(rssCollections.id, collectionId));
    if (!collection) return false;

    const rawItems = await this.db
      .select({
        id: rssItems.id,
        title: rssItems.title,
        link: rssItems.link,
        summary: rssItems.summary,
        publishedAt: rssItems.publishedAt,
        feedId: rssFeeds.id,
        feedTitle: rssFeeds.title,
        feedUrl: rssFeeds.feedUrl,
        feedMaxDigestItems: rssFeeds.maxDigestItems,
      })
      .from(rssItems)
      .innerJoin(rssFeeds, eq(rssItems.feedId, rssFeeds.id))
      .where(and(eq(rssFeeds.collectionId, collectionId), isNull(rssItems.digestedAt)))
      .orderBy(desc(rssItems.publishedAt));

    if (rawItems.length === 0) return false;

    // Per-feed truncation: group by feedId, apply per-feed maxDigestItems
    const feedGroups = new Map<
      number,
      { items: typeof rawItems; maxItems: number | null; title: string; url: string }
    >();
    for (const item of rawItems) {
      let group = feedGroups.get(item.feedId);
      if (!group) {
        group = {
          items: [],
          maxItems: item.feedMaxDigestItems,
          title: item.feedTitle,
          url: item.feedUrl,
        };
        feedGroups.set(item.feedId, group);
      }
      group.items.push(item);
    }

    const truncatedFeeds: TruncatedFeedInfo[] = [];
    let items: typeof rawItems = [];
    for (const group of feedGroups.values()) {
      const limit = group.maxItems;
      if (limit != null && group.items.length > limit) {
        truncatedFeeds.push({
          feedTitle: group.title,
          total: group.items.length,
          kept: limit,
          feedUrl: group.url,
        });
        items.push(...group.items.slice(0, limit));
      } else {
        items.push(...group.items);
      }
    }

    // Re-sort merged items by publishedAt descending
    items.sort((a, b) => {
      const ta = a.publishedAt?.getTime() ?? 0;
      const tb = b.publishedAt?.getTime() ?? 0;
      return tb - ta;
    });

    // Apply collection-level total cap
    const maxDisplay = collection.maxDigestItems ?? 30;

    const eventDescription = buildDigestEventDescription(
      collection,
      items,
      maxDisplay,
      truncatedFeeds,
    );
    const fired = this.onDigestTrigger(collection.botId, collection.chatId, eventDescription);

    if (fired) {
      await this.db
        .update(rssCollections)
        .set({ lastDigestAt: new Date() })
        .where(eq(rssCollections.id, collectionId));
      await this.markItemsDigested(rawItems.map((i) => i.id));
    }
    return fired;
  }

  // ── CRUD ──

  async listCollections(botId: string): Promise<RssCollectionRecord[]> {
    const rows = await this.db.select().from(rssCollections).where(eq(rssCollections.botId, botId));
    return rows.map(mapCollectionRecord);
  }

  async getCollection(id: number): Promise<RssCollectionRecord | null> {
    const [row] = await this.db.select().from(rssCollections).where(eq(rssCollections.id, id));
    return row ? mapCollectionRecord(row) : null;
  }

  async createCollection(params: {
    botId: string;
    chatId: number;
    name: string;
    description?: string;
    digestPrompt?: string;
    digestHour?: number;
    digestMinute?: number;
    maxDigestItems?: number | null;
  }): Promise<RssCollectionRecord> {
    const [row] = await this.db
      .insert(rssCollections)
      .values({
        botId: params.botId,
        chatId: params.chatId,
        name: params.name,
        description: params.description ?? null,
        digestPrompt: params.digestPrompt ?? null,
        digestHour: params.digestHour ?? 9,
        digestMinute: params.digestMinute ?? 0,
        maxDigestItems: params.maxDigestItems ?? null,
      })
      .returning();
    return mapCollectionRecord(row!);
  }

  async updateCollection(
    id: number,
    updates: Partial<{
      name: string;
      description: string | null;
      digestPrompt: string | null;
      isActive: boolean;
      digestHour: number;
      digestMinute: number;
      chatId: number;
      maxDigestItems: number | null;
    }>,
  ): Promise<RssCollectionRecord | null> {
    const [row] = await this.db
      .update(rssCollections)
      .set(updates)
      .where(eq(rssCollections.id, id))
      .returning();
    return row ? mapCollectionRecord(row) : null;
  }

  async deleteCollection(id: number): Promise<boolean> {
    const deleted = await this.db
      .delete(rssCollections)
      .where(eq(rssCollections.id, id))
      .returning({ id: rssCollections.id });
    return deleted.length > 0;
  }

  async listFeeds(collectionId: number): Promise<RssFeedRecord[]> {
    const rows = await this.db
      .select()
      .from(rssFeeds)
      .where(eq(rssFeeds.collectionId, collectionId));
    return rows.map(mapFeedRecord);
  }

  async addFeed(
    collectionId: number,
    feedUrl: string,
    title?: string,
    maxDigestItems?: number | null,
  ): Promise<RssFeedRecord> {
    let feedTitle = title ?? feedUrl;
    if (!title) {
      try {
        const parsed = await this.parser.parseURL(feedUrl);
        feedTitle = parsed.title ?? feedUrl;
      } catch {
        // Use URL as fallback title
      }
    }

    const [row] = await this.db
      .insert(rssFeeds)
      .values({
        collectionId,
        feedUrl,
        title: feedTitle,
        maxDigestItems: maxDigestItems ?? null,
      })
      .returning();
    return mapFeedRecord(row!);
  }

  async updateFeed(
    collectionId: number,
    feedId: number,
    updates: Partial<{ title: string; maxDigestItems: number | null }>,
  ): Promise<RssFeedRecord | null> {
    const [row] = await this.db
      .update(rssFeeds)
      .set(updates)
      .where(and(eq(rssFeeds.id, feedId), eq(rssFeeds.collectionId, collectionId)))
      .returning();
    return row ? mapFeedRecord(row) : null;
  }

  async removeFeed(feedId: number, collectionId?: number): Promise<boolean> {
    const conditions = [eq(rssFeeds.id, feedId)];
    if (collectionId != null) conditions.push(eq(rssFeeds.collectionId, collectionId));
    const deleted = await this.db
      .delete(rssFeeds)
      .where(and(...conditions))
      .returning({ id: rssFeeds.id });
    return deleted.length > 0;
  }

  async getUndigestedItems(
    collectionId: number,
    limit = 50,
  ): Promise<{ items: RssItemRecord[]; totalCount: number }> {
    return this.getItems(collectionId, { limit, undigested: true });
  }

  async getItems(
    collectionId: number,
    opts: { limit?: number; offset?: number; undigested?: boolean } = {},
  ): Promise<{ items: RssItemRecord[]; totalCount: number }> {
    const feeds = await this.db
      .select({ id: rssFeeds.id })
      .from(rssFeeds)
      .where(eq(rssFeeds.collectionId, collectionId));

    if (feeds.length === 0) return { items: [], totalCount: 0 };

    const feedIds = feeds.map((f) => f.id);
    const conditions = [inArray(rssItems.feedId, feedIds)];
    if (opts.undigested) conditions.push(isNull(rssItems.digestedAt));

    const [countResult, rows] = await Promise.all([
      this.db
        .select({ count: sql<number>`count(*)::int` })
        .from(rssItems)
        .where(and(...conditions)),
      this.db
        .select()
        .from(rssItems)
        .where(and(...conditions))
        .orderBy(desc(rssItems.publishedAt))
        .limit(opts.limit ?? 50)
        .offset(opts.offset ?? 0),
    ]);

    return {
      items: rows.map(mapItemRecord),
      totalCount: countResult[0]?.count ?? 0,
    };
  }

  async markDigested(collectionId: number) {
    const feeds = await this.db
      .select({ id: rssFeeds.id })
      .from(rssFeeds)
      .where(eq(rssFeeds.collectionId, collectionId));

    if (feeds.length === 0) return;

    await this.db
      .update(rssItems)
      .set({ digestedAt: new Date() })
      .where(
        and(
          inArray(
            rssItems.feedId,
            feeds.map((f) => f.id),
          ),
          isNull(rssItems.digestedAt),
        ),
      );
  }

  async unmarkDigested(collectionId: number) {
    const feeds = await this.db
      .select({ id: rssFeeds.id })
      .from(rssFeeds)
      .where(eq(rssFeeds.collectionId, collectionId));

    if (feeds.length === 0) return;

    await this.db
      .update(rssItems)
      .set({ digestedAt: null })
      .where(
        and(
          inArray(
            rssItems.feedId,
            feeds.map((f) => f.id),
          ),
          isNotNull(rssItems.digestedAt),
        ),
      );
  }

  async unmarkItemsDigested(itemIds: number[]) {
    if (itemIds.length === 0) return;
    await this.db.update(rssItems).set({ digestedAt: null }).where(inArray(rssItems.id, itemIds));
  }

  async markItemsDigested(itemIds: number[]) {
    if (itemIds.length === 0) return;
    await this.db
      .update(rssItems)
      .set({ digestedAt: new Date() })
      .where(and(inArray(rssItems.id, itemIds), isNull(rssItems.digestedAt)));
  }
}
