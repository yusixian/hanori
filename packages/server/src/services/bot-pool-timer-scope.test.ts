import type { Database } from "@cos-tool-bot/database";
import type { IBotManager, TimerRecord } from "@cos-tool-bot/shared";
import type { BotTimerHandlers } from "@cos-tool-bot/bot";
import type { Logger } from "pino";
import { describe, expect, it, vi } from "vitest";
import { BotPool } from "./bot-pool.js";
import type { RegisteredTimer, TimerRegistry } from "./timer-registry.js";

vi.mock("../env.js", () => ({
  env: { ENCRYPTION_KEY: "test-key" },
}));

const BOT_A = "00000000-0000-4000-8000-000000000001";
const BOT_B = "00000000-0000-4000-8000-000000000002";

function timer(id: string, botId: string | null): RegisteredTimer {
  return {
    id,
    botId,
    type: botId ? "ai" : "system",
    name: id,
    chatId: botId ? -1001 : null,
    status: "active",
    intervalMs: botId ? null : 60_000,
    firesAt: botId ? new Date("2026-07-28T00:00:00.000Z") : null,
    createdAt: new Date("2026-07-27T00:00:00.000Z"),
    meta: null,
  };
}

function record(value: RegisteredTimer): TimerRecord {
  return {
    id: value.id,
    botId: value.botId,
    type: value.type,
    name: value.name,
    chatId: value.chatId,
    status: value.status,
    intervalMs: value.intervalMs,
    firesAt: value.firesAt?.toISOString() ?? null,
    createdAt: value.createdAt.toISOString(),
    firedAt: null,
    meta: value.meta,
  };
}

function createPool() {
  const timers = new Map([
    ["timer-a", timer("timer-a", BOT_A)],
    ["timer-b", timer("timer-b", BOT_B)],
    ["system", timer("system", null)],
  ]);
  const listActive = vi.fn(({ botId }: { botId?: string } = {}) =>
    [...timers.values()].filter((entry) => !botId || entry.botId === botId).map(record),
  );
  const cancel = vi.fn(async (timerId: string) => timers.delete(timerId));
  const pauseBot = vi.fn().mockResolvedValue(0);
  const registry = {
    get: (timerId: string) => timers.get(timerId),
    listActive,
    cancel,
    pauseBot,
  } as unknown as TimerRegistry;
  const pool = new BotPool(
    {} as Database,
    { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as unknown as Logger,
    registry,
  );
  const cancelPendingTimerA = vi.fn();
  const cancelPendingTimerB = vi.fn();
  const internals = pool as unknown as {
    managers: Map<string, IBotManager>;
    botTimerHandlers: Map<string, BotTimerHandlers>;
  };
  internals.botTimerHandlers.set(BOT_A, {
    fireTimer: vi.fn(async () => true),
    cancelPendingTimer: cancelPendingTimerA,
  });
  internals.botTimerHandlers.set(BOT_B, {
    fireTimer: vi.fn(async () => true),
    cancelPendingTimer: cancelPendingTimerB,
  });
  return { pool, listActive, cancel, pauseBot, cancelPendingTimerA, cancelPendingTimerB };
}

describe("BotPool timer tenant scope", () => {
  it("lists only timers owned by the requesting Bot", () => {
    const { pool, listActive } = createPool();

    expect(pool.getActiveTimersForBot(BOT_A).map((entry) => entry.id)).toEqual(["timer-a"]);
    expect(listActive).toHaveBeenCalledWith({ botId: BOT_A });
  });

  it("does not let one Bot cancel another Bot's timer", async () => {
    const { pool, cancel, cancelPendingTimerA, cancelPendingTimerB } = createPool();

    await expect(pool.cancelTimerForBot(BOT_A, "timer-b")).resolves.toBe(false);
    expect(cancel).not.toHaveBeenCalled();
    expect(cancelPendingTimerA).not.toHaveBeenCalled();
    expect(cancelPendingTimerB).not.toHaveBeenCalled();
  });

  it("cancels an owned timer in both runtime and registry", async () => {
    const { pool, cancel, cancelPendingTimerA, cancelPendingTimerB } = createPool();

    await expect(pool.cancelTimerForBot(BOT_A, "timer-a")).resolves.toBe(true);
    expect(cancelPendingTimerA).toHaveBeenCalledWith("timer-a");
    expect(cancelPendingTimerB).not.toHaveBeenCalled();
    expect(cancel).toHaveBeenCalledWith("timer-a");
  });

  it("pauses durable timers even when the Bot has no live manager", async () => {
    const { pool, pauseBot } = createPool();
    const internals = pool as unknown as {
      botTimerHandlers: Map<string, BotTimerHandlers>;
      aiSelectionRuntimeDisposers: Map<string, () => void>;
    };
    const dispose = vi.fn();
    internals.aiSelectionRuntimeDisposers.set(BOT_A, dispose);

    await pool.stopBot(BOT_A);

    expect(pauseBot).toHaveBeenCalledWith(BOT_A);
    expect(internals.botTimerHandlers.has(BOT_A)).toBe(false);
    expect(internals.aiSelectionRuntimeDisposers.has(BOT_A)).toBe(false);
    expect(dispose).toHaveBeenCalledOnce();
  });
});
