import type { Database } from "@cos-tool-bot/database";
import type { Logger } from "pino";
import { afterEach, expect, it, vi } from "vitest";
import { MemoryGC } from "./memory-gc.js";
import { EngagementSampleCleaner } from "./engagement-sample-service.js";

const cases = [
  {
    name: "memory",
    create: (query: () => Promise<void>, logger: Logger) => {
      const db = {
        delete: () => ({
          where: () => ({
            returning: async () => {
              await query();
              return [];
            },
          }),
        }),
      } as unknown as Database;
      return new MemoryGC({ db, logger, inactiveRetentionDays: 30, intervalHours: 24 });
    },
  },
  {
    name: "engagement",
    create: (query: () => Promise<void>, logger: Logger) =>
      new EngagementSampleCleaner({ cleanupExpiredContext: query }, logger),
  },
];
afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
});

it.each(cases)("$name close waits for cleanup and prevents restart", async ({ create }) => {
  vi.useFakeTimers();
  let release!: () => void;
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  const query = vi.fn(() => pending);
  const logger = { info: vi.fn(), error: vi.fn() } as unknown as Logger;
  const service = create(query, logger);
  service.start();
  const task = service.close();
  expect(service.close()).toBe(task);
  const closed = vi.fn();
  void task.then(closed);
  service.start();
  await vi.advanceTimersByTimeAsync(24 * 60 * 60_000);
  expect(query).toHaveBeenCalledOnce();
  expect(closed).not.toHaveBeenCalled();
  release();
  await task;
  expect(closed).toHaveBeenCalledOnce();
  expect(vi.getTimerCount()).toBe(0);
});

it.each(cases)("$name close waits for failure logging", async ({ create }) => {
  let reject!: (error: unknown) => void;
  const pending = new Promise<void>((_resolve, onReject) => {
    reject = onReject;
  });
  const logger = { info: vi.fn(), error: vi.fn() };
  const service = create(() => pending, logger as unknown as Logger);
  service.start();
  const task = service.close();
  const error = new Error("database unavailable");
  reject(error);
  await task;
  expect(logger.error).toHaveBeenCalledExactlyOnceWith(error, expect.any(String));
});

it("keeps engagement cleanup single-flight and stop restartable, but close terminal", async () => {
  const query = vi.fn().mockResolvedValue(undefined);
  const service = new EngagementSampleCleaner({ cleanupExpiredContext: query }, {} as Logger);
  service.start();
  await service.cleanup();
  expect(query).toHaveBeenCalledOnce();
  service.stop();
  service.start();
  await service.cleanup();
  expect(query).toHaveBeenCalledTimes(2);
  await service.close();
  await service.cleanup();
  service.start();
  expect(query).toHaveBeenCalledTimes(2);
});
