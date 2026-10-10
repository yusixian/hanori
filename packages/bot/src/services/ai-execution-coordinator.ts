import { drainTasks } from "./drain-tasks.js";
import {
  AiReplyQueueFullError,
  AiReplyScheduler,
  type AiReplySchedulerStats,
} from "./ai-reply-scheduler.js";

const DEFAULT_CANCEL_WAIT_MS = 5_000;

export interface AiRunScope {
  chatId: number;
  userId?: number;
}

export interface AiRunContext {
  readonly signal: AbortSignal;
  isCurrent(): boolean;
}

export interface ScheduledAiRun<T> {
  readonly queued: boolean;
  readonly result: Promise<T>;
  start(): void;
}

export interface AiExecutionCoordinatorStats extends AiReplySchedulerStats {
  readonly tracked: number;
  readonly started: number;
  readonly completed: number;
  readonly rejected: number;
  readonly cancelled: number;
  readonly totalWaitMs: number;
  readonly totalRunMs: number;
  readonly lastWaitMs: number;
  readonly lastRunMs: number;
}

export interface AiRunDrainResult {
  readonly cancelled: number;
  readonly settled: boolean;
  readonly timedOut: boolean;
}

interface RunRecord {
  readonly id: number;
  readonly scope: AiRunScope;
  readonly controller: AbortController;
  readonly runtimeEpoch: number;
  readonly chatEpoch: number;
  readonly userEpoch: number;
  readonly start: () => void;
  settled: Promise<void>;
}

export class AiRunCancelledError extends Error {
  readonly code = "AI_RUN_CANCELLED";

  constructor(message = "AI run was cancelled") {
    super(message);
    this.name = "AiRunCancelledError";
  }
}

export class AiRunDrainTimeoutError extends Error {
  readonly code = "AI_RUN_DRAIN_TIMEOUT";

  constructor(message = "Timed out waiting for AI runs to stop") {
    super(message);
    this.name = "AiRunDrainTimeoutError";
  }
}

export class AiExecutionCoordinator {
  private readonly scheduler: AiReplyScheduler;
  private readonly runs = new Map<number, RunRecord>();
  private readonly chatEpochs = new Map<number, number>();
  private readonly userEpochs = new Map<number, number>();
  private runtimeEpoch = 0;
  private nextRunId = 1;
  private destroyed = false;
  private started = 0;
  private completed = 0;
  private rejected = 0;
  private cancelled = 0;
  private totalWaitMs = 0;
  private totalRunMs = 0;
  private lastWaitMs = 0;
  private lastRunMs = 0;

  constructor(options: { maxConcurrent: number; maxQueued?: number }) {
    this.scheduler = new AiReplyScheduler(options);
  }

  get stats(): AiExecutionCoordinatorStats {
    return Object.freeze({
      ...this.scheduler.stats,
      tracked: this.runs.size,
      started: this.started,
      completed: this.completed,
      rejected: this.rejected,
      cancelled: this.cancelled,
      totalWaitMs: this.totalWaitMs,
      totalRunMs: this.totalRunMs,
      lastWaitMs: this.lastWaitMs,
      lastRunMs: this.lastRunMs,
    });
  }

  schedule<T>(scope: AiRunScope, task: (context: AiRunContext) => Promise<T>): ScheduledAiRun<T> {
    if (this.destroyed) throw new AiRunCancelledError("AI runtime has been destroyed");

    const id = this.nextRunId++;
    const controller = new AbortController();
    const scheduledAt = performance.now();
    let admission;
    try {
      admission = this.scheduler.acquire({
        chatId: scope.chatId,
        userId: scope.userId,
        signal: controller.signal,
      });
    } catch (error) {
      if (error instanceof AiReplyQueueFullError) this.rejected++;
      throw error;
    }
    const startGate = createDeferred<void>();
    let started = false;
    const start = () => {
      if (started) return;
      started = true;
      startGate.resolve();
    };
    const record: RunRecord = {
      id,
      scope,
      controller,
      runtimeEpoch: this.runtimeEpoch,
      chatEpoch: this.chatEpochs.get(scope.chatId) ?? 0,
      userEpoch: scope.userId === undefined ? 0 : (this.userEpochs.get(scope.userId) ?? 0),
      start,
      settled: Promise.resolve(),
    };

    const isCurrent = () => this.isCurrent(record);
    const result = (async () => {
      await startGate.promise;
      const permit = await admission.permit;
      const admittedAt = performance.now();
      this.lastWaitMs = Math.max(0, admittedAt - scheduledAt);
      this.totalWaitMs += this.lastWaitMs;
      try {
        if (!isCurrent()) throw cancellationReason(controller.signal);
        const startedAt = performance.now();
        this.started++;
        try {
          const value = await task({ signal: controller.signal, isCurrent });
          if (!isCurrent()) throw cancellationReason(controller.signal);
          this.completed++;
          return value;
        } finally {
          this.lastRunMs = Math.max(0, performance.now() - startedAt);
          this.totalRunMs += this.lastRunMs;
        }
      } finally {
        permit.release();
      }
    })();
    record.settled = result
      .then(
        () => undefined,
        () => undefined,
      )
      .finally(() => {
        this.runs.delete(id);
      });
    this.runs.set(id, record);

    return Object.freeze({ queued: admission.queued, result, start });
  }

  getChatStats(chatId: number): { active: boolean; queued: number } {
    return this.scheduler.getChatStats(chatId);
  }

  cancelAllNow(reason: unknown = new AiRunCancelledError("AI disabled by /stop")): number {
    this.runtimeEpoch++;
    return this.abortRuns([...this.runs.values()], reason);
  }

  async cancelChat(
    chatId: number,
    reason: unknown = new AiRunCancelledError("AI run cancelled before clearing the chat"),
    waitMs = DEFAULT_CANCEL_WAIT_MS,
  ): Promise<AiRunDrainResult> {
    this.chatEpochs.set(chatId, (this.chatEpochs.get(chatId) ?? 0) + 1);
    const runs = [...this.runs.values()].filter((run) => run.scope.chatId === chatId);
    const cancelled = this.abortRuns(runs, reason);
    return createDrainResult(cancelled, await waitForRuns(runs, waitMs));
  }

  async cancelUser(
    userId: number,
    reason: unknown = new AiRunCancelledError("AI run cancelled before changing privacy data"),
    waitMs = DEFAULT_CANCEL_WAIT_MS,
  ): Promise<AiRunDrainResult> {
    this.userEpochs.set(userId, (this.userEpochs.get(userId) ?? 0) + 1);
    const runs = [...this.runs.values()].filter((run) => run.scope.userId === userId);
    const cancelled = this.abortRuns(runs, reason);
    return createDrainResult(cancelled, await waitForRuns(runs, waitMs));
  }

  destroy(reason: unknown = new AiRunCancelledError("AI runtime was destroyed")): number {
    if (this.destroyed) return 0;
    this.destroyed = true;
    this.runtimeEpoch++;
    const cancelled = this.abortRuns([...this.runs.values()], reason);
    this.scheduler.destroy(reason);
    return cancelled;
  }

  async destroyAndDrain(
    reason: unknown = new AiRunCancelledError("AI runtime was destroyed"),
    waitMs = DEFAULT_CANCEL_WAIT_MS,
  ): Promise<AiRunDrainResult> {
    const runs = [...this.runs.values()];
    const cancelled = this.destroy(reason);
    return createDrainResult(cancelled, await waitForRuns(runs, waitMs));
  }

  private abortRuns(runs: RunRecord[], reason: unknown): number {
    let cancelled = 0;
    for (const run of runs) {
      if (!run.controller.signal.aborted) {
        run.controller.abort(reason);
        cancelled++;
      }
      run.start();
    }
    this.cancelled += cancelled;
    return cancelled;
  }

  private isCurrent(run: RunRecord): boolean {
    return (
      !this.destroyed &&
      !run.controller.signal.aborted &&
      run.runtimeEpoch === this.runtimeEpoch &&
      run.chatEpoch === (this.chatEpochs.get(run.scope.chatId) ?? 0) &&
      (run.scope.userId === undefined ||
        run.userEpoch === (this.userEpochs.get(run.scope.userId) ?? 0))
    );
  }
}

function cancellationReason(signal: AbortSignal): unknown {
  return signal.reason ?? new AiRunCancelledError();
}

interface AiRunWaitResult {
  readonly settled: boolean;
  readonly timedOut: boolean;
}

async function waitForRuns(runs: RunRecord[], waitMs: number): Promise<AiRunWaitResult> {
  return drainTasks(
    runs.map((run) => run.settled),
    waitMs,
  );
}

function createDrainResult(cancelled: number, wait: AiRunWaitResult): AiRunDrainResult {
  return Object.freeze({ cancelled, settled: wait.settled, timedOut: wait.timedOut });
}

function createDeferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}
