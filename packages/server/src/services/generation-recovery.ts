import { isTerminalPixAIRecoveryError } from "@cos-tool-bot/bot";
import { DEFAULT_TIMEOUT_CONFIG, PIXAI_TASK_TIMEOUT_MAX_MS } from "@cos-tool-bot/shared";

export function isTerminalGenerationRecoveryError(error: unknown): boolean {
  return isTerminalPixAIRecoveryError(error);
}

export function resolvePixaiTaskTimeoutMs(timeoutMs?: number): number {
  return Math.min(
    Math.max(timeoutMs ?? DEFAULT_TIMEOUT_CONFIG.pixaiTaskMs, 1_000),
    PIXAI_TASK_TIMEOUT_MAX_MS,
  );
}

export type TerminalGenerationFailurePersistenceResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: unknown };

export async function tryPersistTerminalGenerationFailure<T>(
  persist: () => Promise<T>,
): Promise<TerminalGenerationFailurePersistenceResult<T>> {
  try {
    return { ok: true, value: await persist() };
  } catch (error) {
    return { ok: false, error };
  }
}

export async function confirmPendingInsertAbsent(
  findExisting: () => Promise<unknown | undefined>,
): Promise<boolean> {
  return (await findExisting()) === undefined;
}

export async function persistTerminalGenerationClaim(
  taskId: string,
  updatePending: () => Promise<boolean>,
  insertFallback: () => Promise<boolean>,
): Promise<void> {
  if (await updatePending()) return;
  if (await insertFallback()) return;
  throw new Error(`PixAI generation ${taskId} was already claimed or is no longer pending`);
}

type PendingInsertFallbackEntry =
  | { state: "available"; expiresAt: number }
  | { state: "claimed"; claim: symbol; expiresAt: number }
  | { state: "suppressed"; expiresAt: number };

export const DEFAULT_PENDING_INSERT_FALLBACK_TTL_MS = PIXAI_TASK_TIMEOUT_MAX_MS + 60 * 60 * 1000;

export class PendingGenerationInsertFallbackTracker {
  private readonly entries = new Map<string, PendingInsertFallbackEntry>();

  constructor(
    private readonly ttlMs = DEFAULT_PENDING_INSERT_FALLBACK_TTL_MS,
    private readonly now: () => number = Date.now,
  ) {
    if (!Number.isFinite(ttlMs) || ttlMs <= 0) {
      throw new Error("Pending insert fallback TTL must be positive");
    }
  }

  markPendingInsertFailure(botId: string, taskId: string): void {
    this.pruneExpired();
    const key = this.key(botId, taskId);
    const current = this.entries.get(key);
    if (current?.state === "claimed" || current?.state === "suppressed") return;
    this.entries.set(key, { state: "available", expiresAt: this.now() + this.ttlMs });
  }

  clear(botId: string, taskId: string): void {
    this.pruneExpired();
    this.entries.delete(this.key(botId, taskId));
  }

  suppress(botId: string, taskId: string): void {
    this.pruneExpired();
    this.entries.set(this.key(botId, taskId), {
      state: "suppressed",
      expiresAt: this.now() + this.ttlMs,
    });
  }

  clearBot(botId: string): void {
    this.pruneExpired();
    const prefix = `${botId}:`;
    for (const key of this.entries.keys()) {
      if (key.startsWith(prefix)) this.entries.delete(key);
    }
  }

  pruneExpired(): number {
    const now = this.now();
    let pruned = 0;
    for (const [key, entry] of this.entries) {
      if (entry.expiresAt > now) continue;
      this.entries.delete(key);
      pruned++;
    }
    return pruned;
  }

  async insertIfClaimed(
    botId: string,
    taskId: string,
    confirmAbsent: () => Promise<boolean>,
    insert: () => Promise<unknown>,
  ): Promise<boolean> {
    this.pruneExpired();
    const key = this.key(botId, taskId);
    const current = this.entries.get(key);
    if (current?.state !== "available") return false;

    const claim = Symbol(key);
    const claimed: PendingInsertFallbackEntry = {
      state: "claimed",
      claim,
      expiresAt: current.expiresAt,
    };
    this.entries.set(key, claimed);
    let insertStarted = false;

    try {
      if (!(await confirmAbsent())) {
        if (this.isCurrentClaim(key, claim)) this.entries.delete(key);
        return false;
      }

      // A delete can suppress fallback while the confirmation query is in flight.
      if (!this.isCurrentClaim(key, claim)) return false;
      insertStarted = true;
      await insert();
      if (!this.isCurrentClaim(key, claim)) return false;
      this.entries.delete(key);
      return true;
    } catch (error) {
      if (this.isCurrentClaim(key, claim)) {
        // A failed absence check ran before any write, so retrying remains safe. Once
        // insert starts its commit outcome can be ambiguous, so eligibility is consumed.
        if (insertStarted) {
          this.entries.delete(key);
        } else {
          this.entries.set(key, { state: "available", expiresAt: claimed.expiresAt });
        }
      }
      throw error;
    }
  }

  private isCurrentClaim(key: string, claim: symbol): boolean {
    const entry = this.entries.get(key);
    return entry?.state === "claimed" && entry.claim === claim && entry.expiresAt > this.now();
  }

  private key(botId: string, taskId: string): string {
    return `${botId}:${taskId}`;
  }
}

interface QueuedTask<T> {
  run: () => Promise<T>;
  resolve: (value: T) => void;
  reject: (reason?: unknown) => void;
  signal?: AbortSignal;
  onAbort?: () => void;
}

export class AsyncTaskLimiter {
  private active = 0;
  private queue: QueuedTask<unknown>[] = [];

  constructor(private readonly concurrency: number) {
    if (!Number.isInteger(concurrency) || concurrency < 1) {
      throw new Error("Concurrency must be a positive integer");
    }
  }

  run<T>(task: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    if (signal?.aborted) return Promise.reject(signal.reason);

    return new Promise<T>((resolve, reject) => {
      const queued = { run: task, resolve, reject, signal } as QueuedTask<unknown>;
      if (signal) {
        queued.onAbort = () => {
          const index = this.queue.indexOf(queued);
          if (index === -1) return;
          this.queue.splice(index, 1);
          reject(signal.reason);
        };
        signal.addEventListener("abort", queued.onAbort, { once: true });
      }
      this.queue.push(queued);
      this.drain();
    });
  }

  private drain(): void {
    while (this.active < this.concurrency) {
      const queued = this.queue.shift();
      if (!queued) return;
      if (queued.signal && queued.onAbort) {
        queued.signal.removeEventListener("abort", queued.onAbort);
      }
      if (queued.signal?.aborted) {
        queued.reject(queued.signal.reason);
        continue;
      }

      this.active++;
      void queued
        .run()
        .then(queued.resolve, queued.reject)
        .finally(() => {
          this.active--;
          this.drain();
        });
    }
  }
}
