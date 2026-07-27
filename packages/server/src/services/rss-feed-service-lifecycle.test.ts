import type { Database } from "@cos-tool-bot/database";
import type { Logger } from "pino";
import { describe, expect, it, vi } from "vitest";
import { RssFeedService } from "./rss-feed-service.js";

const COLLECTION = {
  id: 7,
  botId: "00000000-0000-4000-8000-000000000001",
  chatId: -1001,
  name: "News",
  description: null,
  digestPrompt: null,
  isActive: true,
  digestHour: 9,
  digestMinute: 0,
  maxDigestItems: 30,
  lastDigestAt: null,
  createdAt: new Date("2026-07-28T00:00:00.000Z"),
  updatedAt: new Date("2026-07-28T00:00:00.000Z"),
};

const ITEM = {
  id: 11,
  title: "Item",
  link: "https://example.com/item",
  summary: "Summary",
  publishedAt: new Date("2026-07-28T00:00:00.000Z"),
  feedId: 3,
  feedTitle: "Feed",
  feedUrl: "https://example.com/feed.xml",
  feedMaxDigestItems: null,
};

function database() {
  let selectCall = 0;
  const updates: Array<Record<string, unknown>> = [];
  const db = {
    select: () => {
      selectCall += 1;
      return selectCall === 1
        ? { from: () => ({ where: async () => [COLLECTION] }) }
        : {
            from: () => ({
              innerJoin: () => ({
                where: () => ({ orderBy: async () => [ITEM] }),
              }),
            }),
          };
    },
    update: () => ({
      set: (values: Record<string, unknown>) => ({
        where: async () => {
          updates.push(values);
        },
      }),
    }),
  } as unknown as Database;
  return { db, updates };
}

const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as unknown as Logger;

describe("RssFeedService Bot lifecycle", () => {
  it("does not consume a due digest when the Bot runtime cannot accept it", async () => {
    const { db, updates } = database();
    const service = new RssFeedService(db, logger);
    service.setDigestTrigger(() => false);

    await expect(service.triggerDigest(COLLECTION.id)).resolves.toBe(false);
    expect(updates).toEqual([]);
  });

  it("records completion only after a running Bot accepts the digest", async () => {
    const { db, updates } = database();
    const service = new RssFeedService(db, logger);
    service.setDigestTrigger(() => true);

    await expect(service.triggerDigest(COLLECTION.id)).resolves.toBe(true);
    expect(updates).toEqual([{ lastDigestAt: expect.any(Date) }, { digestedAt: expect.any(Date) }]);
  });

  it("does not advance checkpoints when asynchronous delivery fails", async () => {
    const { db, updates } = database();
    const service = new RssFeedService(db, logger);
    service.setDigestTrigger(async () => false);

    await expect(service.triggerDigest(COLLECTION.id)).resolves.toBe(false);
    expect(updates).toEqual([]);
  });
});
