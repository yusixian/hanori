import type { Logger } from "pino";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AsyncTaskLimiter, PendingGenerationInsertFallbackTracker } from "./generation-recovery.js";
import type { BotManager } from "./bot-manager.js";
import { BotPool } from "./bot-pool.js";

vi.mock("../env.js", () => ({
  env: { ENCRYPTION_KEY: "test-key" },
}));

interface RecoveryEntry {
  controller: AbortController;
  promise: Promise<void>;
}

interface RecoveryConfig {
  manager: BotManager;
  apiKey: string;
  timeoutMs: number;
}

interface RecoveryTestPool {
  managers: Map<string, BotManager>;
  generationRecoveries: Map<string, RecoveryEntry>;
  generationRecoveryConfigs: Map<string, RecoveryConfig>;
  generationRecoveryEpochs: Map<string, number>;
  generationRecoveryLimiter: AsyncTaskLimiter;
  generationInsertFallbacks: PendingGenerationInsertFallbackTracker;
  generationRecoverySweep?: Promise<void>;
  generationRecoveryTimer?: ReturnType<typeof setInterval>;
  db: unknown;
  logger: Logger;
  schedulePendingGenerationRecovery(
    botId: string,
    manager: BotManager,
    apiKey: string,
    timeoutMs: number,
  ): Promise<number>;
  cancelGenerationRecoveries(botId: string, reason: string): Promise<void>;
  clearDeletedBotGenerationState(botId: string): void;
  startGenerationRecoveryScheduler(): void;
  stopGenerationRecoverySchedulerIfIdle(): void;
}

function pendingRow(taskId = "task-1") {
  return {
    chatId: 123,
    userId: null,
    taskId,
    prompt: "prompt",
    negativePrompt: null,
    modelId: "model",
    width: 512,
    height: 512,
    batchSize: 1,
    samplingSteps: null,
    cfgScale: null,
    promptHelper: null,
    pixaiConfig: null,
    createdAt: new Date(0),
  };
}

function createPool(queryPending: () => Promise<ReturnType<typeof pendingRow>[]>) {
  const pool = Object.create(BotPool.prototype) as RecoveryTestPool;
  pool.managers = new Map();
  pool.generationRecoveries = new Map();
  pool.generationRecoveryConfigs = new Map();
  pool.generationRecoveryEpochs = new Map();
  pool.generationRecoveryLimiter = new AsyncTaskLimiter(3);
  pool.generationInsertFallbacks = new PendingGenerationInsertFallbackTracker();
  pool.db = {
    select: vi.fn(() => ({
      from: vi.fn(() => ({ where: vi.fn(queryPending) })),
    })),
  };
  pool.logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as unknown as Logger;
  return pool;
}

function createManager(recover = vi.fn().mockResolvedValue(undefined)) {
  return {
    status: "running",
    recoverPixaiGeneration: recover,
    sendHtml: vi.fn().mockResolvedValue(undefined),
  } as unknown as BotManager;
}

function setTerminalClaimResult(pool: RecoveryTestPool, claimed: Array<{ chatId: number }>) {
  pool.db = {
    ...(pool.db as object),
    update: vi.fn(() => ({
      set: vi.fn(() => ({
        where: vi.fn(() => ({
          returning: vi.fn().mockResolvedValue(claimed),
        })),
      })),
    })),
  };
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("BotPool generation recovery lifecycle", () => {
  it("retains the recovery epoch across stops and clears it only after permanent deletion", async () => {
    const pool = createPool(async () => []);

    await pool.cancelGenerationRecoveries("bot-a", "bot stopped");

    expect(pool.generationRecoveryEpochs.get("bot-a")).toBe(1);

    pool.clearDeletedBotGenerationState("bot-a");

    expect(pool.generationRecoveryEpochs.has("bot-a")).toBe(false);
  });

  it("invalidates a stale database scan before it can enqueue work", async () => {
    let releaseQuery!: (rows: ReturnType<typeof pendingRow>[]) => void;
    const query = new Promise<ReturnType<typeof pendingRow>[]>((resolve) => {
      releaseQuery = resolve;
    });
    const pool = createPool(() => query);
    const recover = vi.fn().mockResolvedValue(undefined);
    const manager = createManager(recover);
    pool.managers.set("bot-a", manager);

    const scheduling = pool.schedulePendingGenerationRecovery("bot-a", manager, "old-key", 1_000);
    await pool.cancelGenerationRecoveries("bot-a", "API key updated");
    releaseQuery([pendingRow()]);

    await expect(scheduling).resolves.toBe(0);
    expect(recover).not.toHaveBeenCalled();
  });

  it("aborts and awaits active recovery without removing its entry early", async () => {
    let finishRecovery!: () => void;
    const recover = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finishRecovery = resolve;
        }),
    );
    const pool = createPool(async () => [pendingRow()]);
    const manager = createManager(recover);
    pool.managers.set("bot-a", manager);

    await expect(
      pool.schedulePendingGenerationRecovery("bot-a", manager, "key", 1_000),
    ).resolves.toBe(1);
    const cancelling = pool.cancelGenerationRecoveries("bot-a", "bot stopped");
    let cancelled = false;
    void cancelling.then(() => {
      cancelled = true;
    });

    expect(pool.generationRecoveries.get("bot-a:task-1")?.controller.signal.aborted).toBe(true);
    expect(pool.generationRecoveries.has("bot-a:task-1")).toBe(true);
    expect(cancelled).toBe(false);

    finishRecovery();
    await cancelling;
    expect(cancelled).toBe(true);
    expect(pool.generationRecoveries.has("bot-a:task-1")).toBe(false);
  });

  it("periodically retries rows that become stale or previously failed transiently", async () => {
    vi.useFakeTimers();
    const queryPending = vi
      .fn<() => Promise<ReturnType<typeof pendingRow>[]>>()
      .mockResolvedValueOnce([])
      .mockResolvedValue([pendingRow()]);
    const recover = vi.fn().mockRejectedValue(new Error("PixAI API error: 503"));
    const pool = createPool(queryPending);
    const manager = createManager(recover);
    pool.managers.set("bot-a", manager);
    pool.generationRecoveryConfigs.set("bot-a", {
      manager,
      apiKey: "key",
      timeoutMs: 1_000,
    });
    pool.startGenerationRecoveryScheduler();

    await vi.advanceTimersByTimeAsync(60_000);
    expect(queryPending).toHaveBeenCalledOnce();
    expect(recover).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(60_000);
    await vi.waitFor(() => expect(recover).toHaveBeenCalledTimes(1));

    await vi.advanceTimersByTimeAsync(60_000);
    await vi.waitFor(() => expect(recover).toHaveBeenCalledTimes(2));

    pool.generationRecoveryConfigs.clear();
    pool.stopGenerationRecoverySchedulerIfIdle();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("notifies only after atomically claiming a terminal recovery failure", async () => {
    let rejectRecovery!: (error: Error) => void;
    const recover = vi.fn(() => new Promise<void>((_resolve, reject) => (rejectRecovery = reject)));
    const pool = createPool(async () => [pendingRow()]);
    setTerminalClaimResult(pool, [{ chatId: 123 }]);
    const manager = createManager(recover);
    pool.managers.set("bot-a", manager);

    await expect(
      pool.schedulePendingGenerationRecovery("bot-a", manager, "key", 1_000),
    ).resolves.toBe(1);
    const completion = pool.generationRecoveries.get("bot-a:task-1")!.promise;
    rejectRecovery(new Error("PixAI task failed: rejected"));
    await completion;

    expect(manager.sendHtml).toHaveBeenCalledWith(123, "图片生成失败: PixAI task failed: rejected");
  });

  it("does not notify after another worker owns the terminal failure", async () => {
    let rejectRecovery!: (error: Error) => void;
    const recover = vi.fn(() => new Promise<void>((_resolve, reject) => (rejectRecovery = reject)));
    const pool = createPool(async () => [pendingRow()]);
    setTerminalClaimResult(pool, []);
    const manager = createManager(recover);
    pool.managers.set("bot-a", manager);

    await expect(
      pool.schedulePendingGenerationRecovery("bot-a", manager, "key", 1_000),
    ).resolves.toBe(1);
    const completion = pool.generationRecoveries.get("bot-a:task-1")!.promise;
    rejectRecovery(new Error("PixAI task failed: rejected"));
    await completion;

    expect(manager.sendHtml).not.toHaveBeenCalled();
  });
});
