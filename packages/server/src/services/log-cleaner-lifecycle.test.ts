import type { Database } from "@cos-tool-bot/database";
import type { Logger } from "pino";
import { afterEach, expect, it, vi } from "vitest";
import { LogCleaner } from "./log-cleaner.js";
import { BotRunCleaner } from "./bot-run-cleaner.js";

const cases = [
  {
    name: "logs",
    queries: 2,
    create: (db: Database, logger: Logger) =>
      new LogCleaner({ db, logger, retentionDays: 7, retentionDaysError: 30, intervalHours: 24 }),
  },
  {
    name: "runs",
    queries: 1,
    create: (db: Database, logger: Logger) => new BotRunCleaner(db, logger),
  },
];
afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
});

it.each(cases)(
  "$name close waits for admitted queries and permanently stops scheduling",
  async ({ create, queries }) => {
    vi.useFakeTimers();
    let release!: () => void;
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    const query = vi.fn(async () => {
      await pending;
      return { count: 0 };
    });
    const db = { delete: () => ({ where: query }) } as unknown as Database;
    const logger = { info: vi.fn(), debug: vi.fn(), error: vi.fn() } as unknown as Logger;
    const service = create(db, logger);
    service.start();
    expect(query).toHaveBeenCalledOnce();
    const closed = vi.fn();
    const task = service.close();
    void task.then(closed);
    expect(service.close()).toBe(task);
    service.start();
    await vi.advanceTimersByTimeAsync(24 * 60 * 60_000);
    expect(query).toHaveBeenCalledOnce();
    expect(closed).not.toHaveBeenCalled();
    release();
    await task;
    expect(query).toHaveBeenCalledTimes(queries);
    expect(closed).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  },
);

it.each(cases)(
  "$name close waits for failure diagnostics without rejecting",
  async ({ create }) => {
    let reject!: (error: unknown) => void;
    const pending = new Promise<never>((_resolve, onReject) => {
      reject = onReject;
    });
    const error = new Error("query failed");
    const db = { delete: () => ({ where: () => pending }) } as unknown as Database;
    const logger = { info: vi.fn(), debug: vi.fn(), error: vi.fn() };
    const service = create(db, logger as unknown as Logger);
    service.start();
    const task = service.close();
    reject(error);
    await task;
    expect(logger.error).toHaveBeenCalledExactlyOnceWith(error, expect.any(String));
  },
);

it("does not admit manual Bot Run cleanup after close", async () => {
  const query = vi.fn();
  const db = { delete: query } as unknown as Database;
  const service = new BotRunCleaner(db, {} as Logger);
  await service.close();
  await service.clean();
  expect(query).not.toHaveBeenCalled();
});

it("keeps log cleanup open until the error-retention query finishes", async () => {
  let release!: () => void;
  const pending = new Promise<{ count: number }>((resolve) => {
    release = () => resolve({ count: 0 });
  });
  const query = vi.fn().mockResolvedValueOnce({ count: 0 }).mockReturnValueOnce(pending);
  const db = { delete: () => ({ where: query }) } as unknown as Database;
  const logger = { info: vi.fn(), error: vi.fn() } as unknown as Logger;
  const service = new LogCleaner({
    db,
    logger,
    retentionDays: 7,
    retentionDaysError: 30,
    intervalHours: 24,
  });
  service.start();
  const closed = vi.fn();
  const task = service.close();
  void task.then(closed);
  await vi.waitFor(() => expect(query).toHaveBeenCalledTimes(2));
  expect(closed).not.toHaveBeenCalled();
  release();
  await task;
  expect(closed).toHaveBeenCalledOnce();
});
