export function isTerminalGenerationRecoveryError(errorMessage: string): boolean {
  return (
    /PixAI task (?:failed|cancelled)/i.test(errorMessage) ||
    /PixAI task timed out after/i.test(errorMessage)
  );
}

export type TerminalGenerationFailurePersistenceResult =
  | { ok: true }
  | { ok: false; error: unknown };

export async function tryPersistTerminalGenerationFailure(
  persist: () => Promise<unknown>,
): Promise<TerminalGenerationFailurePersistenceResult> {
  try {
    await persist();
    return { ok: true };
  } catch (error) {
    return { ok: false, error };
  }
}

export async function confirmPendingInsertAbsent(
  findExisting: () => Promise<unknown | undefined>,
): Promise<boolean> {
  try {
    return (await findExisting()) === undefined;
  } catch {
    return false;
  }
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

type PendingInsertFallbackClaim = symbol;

export class PendingGenerationInsertFallbackTracker {
  private readonly entries = new Map<string, PendingInsertFallbackClaim | null>();

  markPendingInsertFailure(botId: string, taskId: string): void {
    this.entries.set(this.key(botId, taskId), null);
  }

  clear(botId: string, taskId: string): void {
    this.entries.delete(this.key(botId, taskId));
  }

  async insertIfClaimed(
    botId: string,
    taskId: string,
    insert: () => Promise<unknown>,
  ): Promise<boolean> {
    const key = this.key(botId, taskId);
    if (this.entries.get(key) !== null) return false;

    const claim = Symbol(key);
    this.entries.set(key, claim);
    try {
      await insert();
      if (this.entries.get(key) === claim) this.entries.delete(key);
      return true;
    } catch (error) {
      if (this.entries.get(key) === claim) this.entries.delete(key);
      throw error;
    }
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
