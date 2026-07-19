import type { Logger } from "pino";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BotPool } from "./bot-pool.js";

vi.mock("../env.js", () => ({
  env: { ENCRYPTION_KEY: "test-key" },
}));

interface RetentionTestPool {
  conversationCleanupAt: Map<string, number>;
  conversationCleanupInFlight: Map<string, Promise<void>>;
  conversationCleanupSweep?: Promise<void>;
  conversationCleanupTimer?: ReturnType<typeof setInterval>;
  conversationStore: { cleanup: ReturnType<typeof vi.fn> };
  managers: Map<string, unknown>;
  db: unknown;
  logger: Logger;
  startBot: ReturnType<typeof vi.fn>;
  startAll(): Promise<void>;
  stopAll(): Promise<void>;
  triggerConversationCleanup(botId: string, retentionDays: number): void;
}

function createPool(
  cleanup = vi.fn().mockResolvedValue(undefined),
  getActiveBots: () => unknown[] = () => [],
) {
  const pool = Object.create(BotPool.prototype) as RetentionTestPool;
  pool.conversationCleanupAt = new Map();
  pool.conversationCleanupInFlight = new Map();
  pool.conversationStore = { cleanup };
  pool.managers = new Map();
  pool.db = {
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(async () => getActiveBots()),
      })),
    })),
  };
  pool.logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as unknown as Logger;
  pool.startBot = vi.fn().mockResolvedValue(undefined);
  return pool;
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("BotPool conversation retention", () => {
  it("throttles cleanup per bot instead of per chat trigger", () => {
    vi.spyOn(Date, "now").mockReturnValue(10_000_000);
    const pool = createPool();

    pool.triggerConversationCleanup("bot-a", 30);
    pool.triggerConversationCleanup("bot-a", 30);
    pool.triggerConversationCleanup("bot-b", 30);

    expect(pool.conversationStore.cleanup).toHaveBeenCalledTimes(2);
    expect(pool.conversationStore.cleanup).toHaveBeenCalledWith("bot-a", 30);
    expect(pool.conversationStore.cleanup).toHaveBeenCalledWith("bot-b", 30);
  });

  it("does not schedule retention when it is disabled", () => {
    const pool = createPool();

    pool.triggerConversationCleanup("bot-a", 0);

    expect(pool.conversationStore.cleanup).not.toHaveBeenCalled();
  });

  it("allows the next trigger to retry after cleanup fails", async () => {
    vi.spyOn(Date, "now").mockReturnValue(10_000_000);
    const cleanup = vi
      .fn()
      .mockRejectedValueOnce(new Error("database unavailable"))
      .mockResolvedValueOnce(undefined);
    const pool = createPool(cleanup);

    pool.triggerConversationCleanup("bot-a", 30);
    await vi.waitFor(() => expect(pool.conversationCleanupAt.has("bot-a")).toBe(false));
    pool.triggerConversationCleanup("bot-a", 30);

    expect(cleanup).toHaveBeenCalledTimes(2);
  });

  it("sweeps active bots on startup without waiting for a message", async () => {
    const cleanup = vi.fn().mockResolvedValue(undefined);
    const pool = createPool(cleanup, () => [
      { id: "bot-a", name: "A", aiConfig: { conversationConfig: { retentionDays: 30 } } },
      { id: "bot-b", name: "B", aiConfig: { conversationConfig: { retentionDays: 7 } } },
    ]);

    await pool.startAll();

    expect(cleanup).toHaveBeenCalledTimes(2);
    expect(cleanup).toHaveBeenCalledWith("bot-a", 30);
    expect(cleanup).toHaveBeenCalledWith("bot-b", 7);
    expect(pool.startBot).toHaveBeenCalledTimes(2);

    await pool.stopAll();
  });

  it("starts bots without waiting for retention cleanup to finish", async () => {
    let resolveCleanup!: () => void;
    const cleanup = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveCleanup = resolve;
        }),
    );
    const pool = createPool(cleanup, () => [
      { id: "bot-a", name: "A", aiConfig: { conversationConfig: { retentionDays: 30 } } },
    ]);

    const starting = pool.startAll();
    await vi.waitFor(() => expect(cleanup).toHaveBeenCalledOnce());
    const startedBeforeCleanupFinished = pool.startBot.mock.calls.length === 1;
    resolveCleanup();
    await starting;

    expect(startedBeforeCleanupFinished).toBe(true);

    await pool.stopAll();
  });

  it("skips disabled retention during startup sweep and keeps bots isolated", async () => {
    const cleanup = vi.fn().mockResolvedValue(undefined);
    const pool = createPool(cleanup, () => [
      {
        id: "bot-disabled",
        name: "Disabled",
        aiConfig: { conversationConfig: { retentionDays: 0 } },
      },
      {
        id: "bot-enabled",
        name: "Enabled",
        aiConfig: { conversationConfig: { retentionDays: 14 } },
      },
    ]);

    await pool.startAll();

    expect(cleanup).toHaveBeenCalledOnce();
    expect(cleanup).toHaveBeenCalledWith("bot-enabled", 14);

    await pool.stopAll();
  });

  it("uses one periodic timer, reloads current config, and removes it on stop", async () => {
    vi.useFakeTimers();
    let retentionDays = 30;
    const cleanup = vi.fn().mockResolvedValue(undefined);
    const pool = createPool(cleanup, () => [
      {
        id: "bot-a",
        name: "A",
        aiConfig: { conversationConfig: { retentionDays } },
      },
    ]);

    await pool.startAll();
    expect(cleanup).toHaveBeenLastCalledWith("bot-a", 30);
    expect(vi.getTimerCount()).toBe(1);

    retentionDays = 5;
    await vi.advanceTimersByTimeAsync(60 * 60 * 1000);
    expect(cleanup).toHaveBeenLastCalledWith("bot-a", 5);
    expect(cleanup).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(1);

    await pool.stopAll();
    expect(vi.getTimerCount()).toBe(0);

    await vi.advanceTimersByTimeAsync(2 * 60 * 60 * 1000);
    expect(cleanup).toHaveBeenCalledTimes(2);
  });
});
