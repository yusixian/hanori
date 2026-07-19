import type { Logger } from "pino";
import type { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
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
  preexistingPendingCutoff: Date;
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
  queryWhere: ReturnType<typeof vi.fn>;
  queryOrderBy: ReturnType<typeof vi.fn>;
  queryLimit: ReturnType<typeof vi.fn>;
  db: unknown;
  logger: Logger;
  schedulePendingGenerationRecovery(
    botId: string,
    manager: BotManager,
    apiKey: string,
    timeoutMs: number,
    pendingCutoff: Date,
  ): Promise<number>;
  cancelGenerationRecoveries(botId: string, reason: string): Promise<void>;
  clearDeletedBotGenerationState(botId: string): void;
  runGenerationRecoverySweep(): Promise<void>;
  startGenerationRecoveryScheduler(): void;
  stopGenerationRecoverySchedulerIfIdle(): void;
}

function pendingRow(taskId = "task-1", createdAt = new Date(0)) {
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
    createdAt,
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
  pool.queryLimit = vi.fn(queryPending);
  pool.queryOrderBy = vi.fn(() => ({ limit: pool.queryLimit }));
  pool.queryWhere = vi.fn(() => ({ orderBy: pool.queryOrderBy }));
  pool.db = {
    select: vi.fn(() => ({
      from: vi.fn(() => ({ where: pool.queryWhere })),
    })),
  };
  pool.logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as unknown as Logger;
  return pool;
}

function renderSql(expression: unknown) {
  return new PgDialect().sqlToQuery(expression as SQL);
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
  it("queries eligible pending tasks oldest-first in a concurrency-sized batch", async () => {
    const pendingCutoff = new Date("2026-07-20T00:00:00.000Z");
    const pool = createPool(async () => []);
    const manager = createManager();
    pool.managers.set("bot-a", manager);

    await pool.schedulePendingGenerationRecovery("bot-a", manager, "key", 300_000, pendingCutoff);

    expect(renderSql(pool.queryWhere.mock.calls[0]![0])).toMatchObject({
      sql: expect.stringContaining('"pixai_generations"."created_at" <='),
      params: ["bot-a", "pending", pendingCutoff.toISOString()],
    });
    expect(renderSql(pool.queryOrderBy.mock.calls[0]![0]).sql).toContain(
      '"pixai_generations"."created_at" asc',
    );
    expect(pool.queryLimit).toHaveBeenCalledWith(3);
  });

  it("does not make post-startup rows eligible before they become stale", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-20T00:00:00.000Z"));
    const pool = createPool(async () => []);
    const manager = createManager();
    pool.managers.set("bot-a", manager);
    const preexistingPendingCutoff = new Date();
    const postStartupRow = pendingRow(
      "new-task",
      new Date(preexistingPendingCutoff.getTime() + 1_000),
    );
    pool.generationRecoveryConfigs.set("bot-a", {
      manager,
      apiKey: "key",
      timeoutMs: 300_000,
      preexistingPendingCutoff,
    });

    await vi.advanceTimersByTimeAsync(60_000);
    await pool.runGenerationRecoverySweep();

    expect(renderSql(pool.queryWhere.mock.calls[0]![0])).toMatchObject({
      sql: expect.stringContaining('"pixai_generations"."created_at" <='),
      params: ["bot-a", "pending", preexistingPendingCutoff.toISOString()],
    });
    expect(postStartupRow.createdAt.getTime()).toBeGreaterThan(preexistingPendingCutoff.getTime());
    expect(manager.recoverPixaiGeneration).not.toHaveBeenCalled();
    expect(pool.queryLimit).toHaveBeenCalledWith(3);
  });

  it("drains preexisting pending rows as recovery slots become available", async () => {
    const pendingCutoff = new Date("2026-07-20T00:00:00.000Z");
    const rows = [
      pendingRow("task-1", new Date(pendingCutoff.getTime() - 4_000)),
      pendingRow("task-2", new Date(pendingCutoff.getTime() - 3_000)),
      pendingRow("task-3", new Date(pendingCutoff.getTime() - 2_000)),
      pendingRow("task-4", new Date(pendingCutoff.getTime() - 1_000)),
    ];
    const queryPending = vi
      .fn<() => Promise<ReturnType<typeof pendingRow>[]>>()
      .mockResolvedValueOnce(rows.slice(0, 3))
      .mockResolvedValueOnce([rows[3]!]);
    const releases = new Map<string, () => void>();
    const recover = vi.fn(
      (record: ReturnType<typeof pendingRow>) =>
        new Promise<void>((resolve) => releases.set(record.taskId, resolve)),
    );
    const pool = createPool(queryPending);
    const manager = createManager(recover);
    pool.managers.set("bot-a", manager);
    pool.generationRecoveryConfigs.set("bot-a", {
      manager,
      apiKey: "key",
      timeoutMs: 300_000,
      preexistingPendingCutoff: pendingCutoff,
    });

    await expect(
      pool.schedulePendingGenerationRecovery("bot-a", manager, "key", 300_000, pendingCutoff),
    ).resolves.toBe(3);
    expect(recover.mock.calls.map(([record]) => record.taskId)).toEqual([
      "task-1",
      "task-2",
      "task-3",
    ]);

    await pool.runGenerationRecoverySweep();
    expect(queryPending).toHaveBeenCalledOnce();

    const firstCompletion = pool.generationRecoveries.get("bot-a:task-1")!.promise;
    releases.get("task-1")!();
    await firstCompletion;
    await pool.runGenerationRecoverySweep();

    expect(queryPending).toHaveBeenCalledTimes(2);
    expect(recover.mock.calls.map(([record]) => record.taskId)).toEqual([
      "task-1",
      "task-2",
      "task-3",
      "task-4",
    ]);
    expect(pool.generationRecoveries.size).toBe(3);

    for (const release of releases.values()) release();
    await Promise.allSettled([...pool.generationRecoveries.values()].map((entry) => entry.promise));
  });

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

    const scheduling = pool.schedulePendingGenerationRecovery(
      "bot-a",
      manager,
      "old-key",
      1_000,
      new Date(),
    );
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
      pool.schedulePendingGenerationRecovery("bot-a", manager, "key", 1_000, new Date()),
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
      preexistingPendingCutoff: new Date(0),
    });
    pool.startGenerationRecoveryScheduler();

    await vi.advanceTimersByTimeAsync(60_000);
    expect(queryPending).toHaveBeenCalledOnce();
    expect(renderSql(pool.queryWhere.mock.calls[0]![0])).toMatchObject({
      sql: expect.stringContaining('"pixai_generations"."created_at" <='),
      params: ["bot-a", "pending", new Date(Date.now() - 61_000).toISOString()],
    });
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
      pool.schedulePendingGenerationRecovery("bot-a", manager, "key", 1_000, new Date()),
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
      pool.schedulePendingGenerationRecovery("bot-a", manager, "key", 1_000, new Date()),
    ).resolves.toBe(1);
    const completion = pool.generationRecoveries.get("bot-a:task-1")!.promise;
    rejectRecovery(new Error("PixAI task failed: rejected"));
    await completion;

    expect(manager.sendHtml).not.toHaveBeenCalled();
  });
});
