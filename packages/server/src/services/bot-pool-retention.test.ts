import type { Database } from "@cos-tool-bot/database";
import type { Logger } from "pino";
import { describe, expect, it, vi } from "vitest";
import { BotPool } from "./bot-pool.js";
import type { TimerRegistry } from "./timer-registry.js";
vi.mock("../env.js", () => ({ env: { ENCRYPTION_KEY: "test-key" } }));

describe("BotPool retention wiring", () => {
  it("starts bots without awaiting cleanup and drains cleanup on shutdown", async () => {
    const db = {
      select: () => ({
        from: () => ({
          where: async () => [
            { id: "a", aiConfig: { conversationConfig: { retentionDays: 7 } } },
            { id: "disabled", aiConfig: { conversationConfig: { retentionDays: 0 } } },
          ],
        }),
      }),
    } as unknown as Database;
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as unknown as Logger;
    const pool = new BotPool(db, logger, {} as TimerRegistry);
    const task = deferred<void>();
    const cleanup = vi.spyOn(pool.getConversationStore(), "cleanup").mockReturnValue(task.promise);
    const start = vi.spyOn(pool, "startBot").mockResolvedValue(undefined);
    const stopped = vi.fn();
    try {
      await pool.startAll();
      expect(start).toHaveBeenCalledTimes(2);
      expect(cleanup).toHaveBeenCalledExactlyOnceWith("a", 7);
      const stopping = pool.stopAll().then(stopped);
      await Promise.resolve();
      expect(stopped).not.toHaveBeenCalled();
      task.resolve();
      await stopping;
      expect(stopped).toHaveBeenCalledOnce();
    } finally {
      task.resolve();
      await pool.stopAll();
      vi.restoreAllMocks();
    }
  });
});

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}
