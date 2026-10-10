import Parser from "rss-parser";
import type { Database } from "@cos-tool-bot/database";
import { rssCollections } from "@cos-tool-bot/database";
import type { Logger } from "pino";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { RssFeedService } from "./rss-feed-service.js";

function fixture() {
  const query = vi.fn().mockResolvedValue([]);
  const db = { select: () => ({ from: () => ({ where: query }) }) } as unknown as Database;
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const service = new RssFeedService(db, logger as unknown as Logger);
  return { service, query, logger };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  vi.restoreAllMocks();
  vi.clearAllTimers();
  vi.useRealTimers();
});

it("cancels the initial poll and periodic work when stopped before startup delay", async () => {
  const { service, query } = fixture();
  service.start();
  service.stop();
  await vi.advanceTimersByTimeAsync(31 * 60_000);
  expect(query).not.toHaveBeenCalled();
  expect(vi.getTimerCount()).toBe(0);
});

it("starts only one initial poll and interval across repeated starts", async () => {
  const { service, query } = fixture();
  service.start();
  service.start();
  await vi.advanceTimersByTimeAsync(30 * 60_000);
  expect(query).toHaveBeenCalledTimes(2);
  service.stop();
  await vi.advanceTimersByTimeAsync(30 * 60_000);
  expect(query).toHaveBeenCalledTimes(2);
  expect(vi.getTimerCount()).toBe(0);
});

it("restarts with a fresh initial delay and no callbacks from the previous start", async () => {
  const { service, query } = fixture();
  service.start();
  await vi.advanceTimersByTimeAsync(2_000);
  service.stop();
  service.start();
  await vi.advanceTimersByTimeAsync(3_000);
  expect(query).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(2_000);
  expect(query).toHaveBeenCalledOnce();
  service.stop();
  expect(vi.getTimerCount()).toBe(0);
});

it("logs an initial polling failure and retries at the normal interval", async () => {
  const { service, query, logger } = fixture();
  const failure = new Error("database unavailable");
  query.mockRejectedValueOnce(failure);
  service.start();
  await vi.advanceTimersByTimeAsync(5_000);
  expect(logger.error).toHaveBeenCalledWith(failure, "RSS initial poll failed");
  await vi.advanceTimersByTimeAsync(30 * 60_000 - 5_000);
  expect(query).toHaveBeenCalledTimes(2);
  service.stop();
});

it("retries failed cleanup on the next poll and throttles only successful cleanup", async () => {
  vi.setSystemTime(new Date("2026-10-10T00:00:00Z"));
  const failure = new Error("temporary cleanup failure");
  const cleanup = vi.fn().mockRejectedValueOnce(failure).mockResolvedValue(undefined);
  const db = {
    select: () => ({
      from: (table: unknown) => ({
        where: async () => (table === rssCollections ? [{ id: 1 }] : []),
      }),
    }),
    delete: () => ({ where: cleanup }),
  } as unknown as Database;
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const service = new RssFeedService(db, logger as unknown as Logger);

  service.start();
  await vi.advanceTimersByTimeAsync(5_000);
  expect(cleanup).toHaveBeenCalledOnce();
  expect(logger.warn).toHaveBeenCalledWith(failure, "RSS cleanup failed");

  await vi.advanceTimersByTimeAsync(30 * 60_000 - 5_000);
  expect(cleanup).toHaveBeenCalledTimes(2);
  await vi.advanceTimersByTimeAsync(30 * 60_000);
  expect(cleanup).toHaveBeenCalledTimes(2);

  // Move wall time without replaying a day of unrelated minute-level digest ticks.
  vi.setSystemTime(new Date("2026-10-11T00:00:00Z"));
  await vi.advanceTimersByTimeAsync(30 * 60_000);
  expect(cleanup).toHaveBeenCalledTimes(2); // Exactly 24 hours since successful cleanup.
  await vi.advanceTimersByTimeAsync(30 * 60_000);
  expect(cleanup).toHaveBeenCalledTimes(3);
  service.stop();
});

it("continues due digests after one collection fails without retrying it in the batch", async () => {
  const { service, query, logger } = fixture();
  vi.setSystemTime(new Date("2026-10-10T09:00:00Z"));
  service.setDigestTrigger(() => true);
  const failure = new Error("collection query failed");
  const trigger = vi
    .spyOn(service, "triggerDigest")
    .mockRejectedValueOnce(failure)
    .mockResolvedValue(true);
  query.mockResolvedValueOnce([]).mockResolvedValueOnce([
    { id: 1, lastDigestAt: null },
    { id: 2, lastDigestAt: null },
    { id: 3, lastDigestAt: new Date() },
  ]);
  service.start();
  await vi.advanceTimersByTimeAsync(60_000);
  service.stop();
  expect(trigger.mock.calls).toEqual([[1], [2]]);
  expect(logger.error).toHaveBeenCalledWith(
    { err: failure, collectionId: 1 },
    "RSS collection digest failed",
  );
  expect(vi.getTimerCount()).toBe(0);
});

it("waits for a scheduled candidate query and skips new digests after close", async () => {
  const { service, query } = fixture();
  service.setDigestTrigger(() => true);
  const trigger = vi.spyOn(service, "triggerDigest");
  let finish!: (rows: unknown[]) => void;
  query.mockResolvedValueOnce([]).mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  service.start();
  await vi.advanceTimersByTimeAsync(60_000);
  let closed = false;
  const close = service.close().then(() => {
    closed = true;
  });
  await Promise.resolve();
  expect(closed).toBe(false);
  finish([{ id: 1, lastDigestAt: null }]);
  await close;
  expect(trigger).not.toHaveBeenCalled();
  service.start();
  await vi.advanceTimersByTimeAsync(31 * 60_000);
  expect(query).toHaveBeenCalledTimes(2);
  expect(vi.getTimerCount()).toBe(0);
  await expect(service.pollAllFeeds()).rejects.toThrow("RSS service is closing");
  await expect(service.pollCollection(1)).rejects.toThrow("RSS service is closing");
  await expect(service.addFeed(1, "https://example.com/feed")).rejects.toThrow(
    "RSS service is closing",
  );
});

it("waits for an admitted feed title fetch and insertion during close", async () => {
  let finish!: (feed: { title: string; items: [] }) => void;
  const parse = vi.spyOn(Parser.prototype, "parseURL").mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const insert = vi.fn(async () => [
    {
      id: 1,
      collectionId: 7,
      feedUrl: "https://example.com/feed",
      title: "Fetched title",
      maxDigestItems: null,
      lastFetchAt: null,
      createdAt: new Date(),
    },
  ]);
  const db = { insert: () => ({ values: () => ({ returning: insert }) }) } as unknown as Database;
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const service = new RssFeedService(db, logger as unknown as Logger);
  const added = service.addFeed(7, "https://example.com/feed");
  expect(parse).toHaveBeenCalledOnce();
  let closed = false;
  const close = service.close().then(() => {
    closed = true;
  });
  await Promise.resolve();
  expect(closed).toBe(false);
  expect(insert).not.toHaveBeenCalled();
  finish({ title: "Fetched title", items: [] });
  await expect(added).resolves.toMatchObject({ title: "Fetched title" });
  await close;
  expect(insert).toHaveBeenCalledOnce();
});
