import Parser from "rss-parser";
import type { Database } from "@cos-tool-bot/database";
import type { Logger } from "pino";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RssFeedService } from "./rss-feed-service.js";

afterEach(() => vi.restoreAllMocks());

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

  it("does not insert a feed when cancellation arrives during URL parsing", async () => {
    const insert = vi.fn();
    const db = { insert } as unknown as Database;
    const service = new RssFeedService(db, logger);
    let releaseParse!: (value: { title: string; items: [] }) => void;
    const parseResult = new Promise<{ title: string; items: [] }>((resolve) => {
      releaseParse = resolve;
    });
    let parsingStarted!: () => void;
    const didStartParsing = new Promise<void>((resolve) => {
      parsingStarted = resolve;
    });
    const parseURL = vi.fn(() => {
      parsingStarted();
      return parseResult;
    });
    vi.spyOn(Parser.prototype, "parseURL").mockImplementation(parseURL);
    const controller = new AbortController();

    const add = service.addFeed(
      COLLECTION.id,
      "https://example.com/feed.xml",
      undefined,
      undefined,
      controller.signal,
    );
    const addResult = expect(add).rejects.toThrow("RSS add cancelled");
    await didStartParsing;
    controller.abort(new Error("RSS add cancelled"));
    releaseParse({ title: "Example feed", items: [] });

    await addResult;
    expect(insert).not.toHaveBeenCalled();
  });
});

it("waits for an accepted digest and both checkpoints during close", async () => {
  const { db, updates } = database();
  const service = new RssFeedService(db, logger);
  let accept!: (accepted: boolean) => void;
  const trigger = vi.fn(
    () =>
      new Promise<boolean>((resolve) => {
        accept = resolve;
      }),
  );
  service.setDigestTrigger(trigger);
  const digest = service.triggerDigest(COLLECTION.id);
  await vi.waitFor(() => expect(trigger).toHaveBeenCalledOnce());
  let closed = false;
  const close = service.close();
  expect(service.close()).toBe(close);
  void close.then(() => {
    closed = true;
  });
  await Promise.resolve();
  expect(closed).toBe(false);
  accept(true);
  await expect(digest).resolves.toBe(true);
  await close;
  expect(updates).toEqual([{ lastDigestAt: expect.any(Date) }, { digestedAt: expect.any(Date) }]);
  await expect(service.triggerDigest(COLLECTION.id)).rejects.toThrow("RSS service is closing");
  expect(trigger).toHaveBeenCalledOnce();
});

it("drains a failed digest without consuming its checkpoints", async () => {
  const { db, updates } = database();
  const service = new RssFeedService(db, logger);
  let fail!: (error: Error) => void;
  const trigger = vi.fn(
    () =>
      new Promise<boolean>((_resolve, reject) => {
        fail = reject;
      }),
  );
  service.setDigestTrigger(trigger);
  const digest = service.triggerDigest(COLLECTION.id);
  const rejected = expect(digest).rejects.toThrow("delivery admission failed");
  await vi.waitFor(() => expect(trigger).toHaveBeenCalledOnce());
  const close = service.close();
  fail(new Error("delivery admission failed"));
  await rejected;
  await expect(close).resolves.toBeUndefined();
  expect(updates).toEqual([]);
});
