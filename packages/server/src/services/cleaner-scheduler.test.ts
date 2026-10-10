import type { Database } from "@cos-tool-bot/database";
import type { Logger } from "pino";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BotRunCleaner } from "./bot-run-cleaner.js";
import { GenerationCleaner } from "./generation-cleaner.js";
import { LogCleaner } from "./log-cleaner.js";
import { MemoryGC } from "./memory-gc.js";

const cases = [
  {
    name: "GenerationCleaner",
    operations: 2,
    failedOperations: 2,
    create: (db: Database, logger: Logger) =>
      new GenerationCleaner({ db, logger, retentionDays: 30, intervalHours: 24 }),
  },
  {
    name: "LogCleaner",
    operations: 2,
    create: (db: Database, logger: Logger) =>
      new LogCleaner({ db, logger, retentionDays: 7, retentionDaysError: 30, intervalHours: 24 }),
  },
  {
    name: "MemoryGC",
    operations: 1,
    create: (db: Database, logger: Logger) =>
      new MemoryGC({ db, logger, inactiveRetentionDays: 30, intervalHours: 24 }),
  },
  {
    name: "BotRunCleaner",
    operations: 1,
    create: (db: Database, logger: Logger) => new BotRunCleaner(db, logger),
  },
];
const INTERVAL = 24 * 60 * 60_000;

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
});

describe.each(cases)("$name scheduling", ({ name, create, operations, failedOperations }) => {
  function fixture() {
    const query = vi.fn().mockResolvedValue({ count: 0 });
    const db = {
      select: () => ({
        from: () => ({
          where: async () => {
            await query();
            return [];
          },
        }),
      }),
      delete: () => ({
        where: () =>
          name === "MemoryGC"
            ? {
                returning: async () => {
                  await query();
                  return [];
                },
              }
            : query(),
      }),
    } as unknown as Database;
    const logger = { info: vi.fn(), debug: vi.fn(), error: vi.fn() };
    return { service: create(db, logger as unknown as Logger), query, logger };
  }

  it("keeps one schedule across repeated starts and stops all periodic work", async () => {
    const { service, query } = fixture();
    service.start();
    service.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(query).toHaveBeenCalledTimes(operations);
    await vi.advanceTimersByTimeAsync(INTERVAL);
    expect(query).toHaveBeenCalledTimes(2 * operations);
    service.stop();
    service.stop();
    await vi.advanceTimersByTimeAsync(INTERVAL);
    expect(query).toHaveBeenCalledTimes(2 * operations);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("starts a fresh periodic schedule after being stopped", async () => {
    const { service, query } = fixture();
    service.start();
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(INTERVAL / 2);
    service.stop();
    service.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(query).toHaveBeenCalledTimes(2 * operations);
    await vi.advanceTimersByTimeAsync(INTERVAL / 2);
    expect(query).toHaveBeenCalledTimes(2 * operations);
    await vi.advanceTimersByTimeAsync(INTERVAL / 2);
    expect(query).toHaveBeenCalledTimes(3 * operations);
    service.stop();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("logs a failed cleanup query and retries on the next interval", async () => {
    const { service, query, logger } = fixture();
    const failure = new Error("database unavailable");
    query.mockRejectedValueOnce(failure);
    service.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(logger.error).toHaveBeenCalledWith(failure, expect.any(String));
    await vi.advanceTimersByTimeAsync(INTERVAL);
    expect(query).toHaveBeenCalledTimes((failedOperations ?? 1) + operations);
    expect(logger.error).toHaveBeenCalledOnce();
    service.stop();
  });
});
