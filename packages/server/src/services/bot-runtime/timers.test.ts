import type { Database } from "@cos-tool-bot/database";
import type { Logger } from "pino";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { BotPool } from "../bot-pool.js";
import { TimerRegistry } from "../timer-registry.js";
import type { BotRuntimeHost } from "./types.js";
import { createTimerCallbacks } from "./timers.js";

vi.mock("../../env.js", () => ({ env: { ENCRYPTION_KEY: "test-key" } }));
beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

it("propagates durable cancellation through the runtime host and preserves tenant scope", async () => {
  let persistedStatus = "active";
  const failure = new Error("database unavailable");
  const persist = vi
    .fn()
    .mockRejectedValueOnce(failure)
    .mockImplementation(async () => {
      persistedStatus = "cancelled";
    });
  const db = {
    insert: () => ({ values: async () => {} }),
    update: () => ({ set: () => ({ where: persist }) }),
    select: () => ({
      from: () => ({
        where: async () => {
          expect(persistedStatus).toBe("cancelled");
          return [];
        },
      }),
    }),
  } as unknown as Database;
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as unknown as Logger;
  const registry = new TimerRegistry(db, logger);
  const pool = new BotPool(db, logger, registry);
  const host = (pool as unknown as { runtimeHost: BotRuntimeHost }).runtimeHost;
  const callbacks = createTimerCallbacks("bot-a", registry, logger, host);
  const foreignCallbacks = createTimerCallbacks("bot-b", registry, logger, host);
  const cancelPendingTimer = vi.fn();
  const fireTimer = vi.fn(async () => true);
  callbacks.onBotReady!({ cancelPendingTimer, fireTimer });
  try {
    await callbacks.onTimerCreate!({
      timerId: "ai_test",
      chatId: 42,
      seconds: 5,
      reason: "test",
      userId: 42,
      handle: setTimeout(() => {}, 5_000),
    });
    await expect(foreignCallbacks.onTimerCancel!("ai_test")).rejects.toThrow("Timer not found");
    expect(persist).not.toHaveBeenCalled();
    await expect(callbacks.onTimerCancel!("ai_test")).rejects.toBe(failure);
    expect(persistedStatus).toBe("active");
    expect(registry.get("ai_test")?.status).toBe("active");
    expect(cancelPendingTimer).not.toHaveBeenCalled();
    await expect(callbacks.onTimerCancel!("ai_test")).resolves.toBeUndefined();
    expect(persistedStatus).toBe("cancelled");
    expect(cancelPendingTimer).toHaveBeenCalledExactlyOnceWith("ai_test");
    expect(registry.get("ai_test")).toBeUndefined();
    await registry.pauseBot("bot-a");
    await expect(registry.resumeBot("bot-a", vi.fn())).resolves.toEqual({
      recovered: 0,
      cancelled: 0,
      immediate: 0,
    });
    await vi.advanceTimersByTimeAsync(5_000);
    expect(fireTimer).not.toHaveBeenCalled();
  } finally {
    registry.destroy();
  }
});
