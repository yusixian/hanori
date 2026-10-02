const DEFAULT_MAX_QUEUED = 100;

export interface AiReplySchedulerOptions {
  maxConcurrent: number;
  maxQueued?: number;
}

export interface AiReplyAcquireOptions {
  chatId: number;
  userId?: number;
  signal?: AbortSignal;
}

export interface AiReplyPermit {
  release(): void;
}

export interface AiReplyAdmission {
  readonly queued: boolean;
  readonly permit: Promise<AiReplyPermit>;
}

export interface AiReplySchedulerStats {
  readonly active: number;
  readonly activeUsers: number;
  readonly queued: number;
  readonly maxConcurrent: number;
  readonly maxQueued: number;
}

export class AiReplyQueueFullError extends Error {
  readonly code = "AI_REPLY_QUEUE_FULL";

  constructor(readonly maxQueued: number) {
    super(`AI reply queue is full (maximum ${maxQueued})`);
    this.name = "AiReplyQueueFullError";
  }
}

export class AiReplySchedulerDestroyedError extends Error {
  readonly code = "AI_REPLY_SCHEDULER_DESTROYED";

  constructor() {
    super("AI reply scheduler has been destroyed");
    this.name = "AiReplySchedulerDestroyedError";
  }
}

interface QueuedAcquire {
  readonly chatId: number;
  readonly userId?: number;
  readonly signal?: AbortSignal;
  resolve: (permit: AiReplyPermit) => void;
  reject: (reason?: unknown) => void;
  onAbort?: () => void;
}

export class AiReplyScheduler {
  private readonly maxConcurrent: number;
  private readonly maxQueued: number;
  private readonly activeChats = new Set<number>();
  private readonly activeUsers = new Set<number>();
  private readonly queue: QueuedAcquire[] = [];
  private active = 0;
  private destroyed = false;

  constructor(options: AiReplySchedulerOptions) {
    if (!Number.isInteger(options.maxConcurrent) || options.maxConcurrent < 1) {
      throw new Error("maxConcurrent must be a positive integer");
    }
    const maxQueued = options.maxQueued ?? DEFAULT_MAX_QUEUED;
    if (!Number.isInteger(maxQueued) || maxQueued < 0) {
      throw new Error("maxQueued must be a non-negative integer");
    }

    this.maxConcurrent = options.maxConcurrent;
    this.maxQueued = maxQueued;
  }

  get stats(): AiReplySchedulerStats {
    return Object.freeze({
      active: this.active,
      activeUsers: this.activeUsers.size,
      queued: this.queue.length,
      maxConcurrent: this.maxConcurrent,
      maxQueued: this.maxQueued,
    });
  }

  getChatStats(chatId: number): { active: boolean; queued: number } {
    return {
      active: this.activeChats.has(chatId),
      queued: this.queue.filter((entry) => entry.chatId === chatId).length,
    };
  }

  acquire(options: AiReplyAcquireOptions): AiReplyAdmission {
    if (this.destroyed) throw new AiReplySchedulerDestroyedError();
    if (options.signal?.aborted) throw options.signal.reason ?? createAbortError();

    if (this.canAcquireImmediately(options.chatId, options.userId)) {
      return {
        queued: false,
        permit: Promise.resolve(this.grant(options.chatId, options.userId)),
      };
    }

    if (this.queue.length >= this.maxQueued) {
      throw new AiReplyQueueFullError(this.maxQueued);
    }

    let resolve!: (permit: AiReplyPermit) => void;
    let reject!: (reason?: unknown) => void;
    const permit = new Promise<AiReplyPermit>((next, fail) => {
      resolve = next;
      reject = fail;
    });
    const queued: QueuedAcquire = {
      chatId: options.chatId,
      userId: options.userId,
      signal: options.signal,
      resolve,
      reject,
    };

    if (options.signal) {
      queued.onAbort = () => {
        const index = this.queue.indexOf(queued);
        if (index === -1) return;
        this.queue.splice(index, 1);
        queued.reject(options.signal?.reason ?? createAbortError());
        this.drain();
      };
      options.signal.addEventListener("abort", queued.onAbort, { once: true });
    }

    this.queue.push(queued);
    return { queued: true, permit };
  }

  destroy(reason: unknown = new AiReplySchedulerDestroyedError()): void {
    if (this.destroyed) return;
    this.destroyed = true;

    const queuedAcquires = this.queue.splice(0);
    for (const queued of queuedAcquires) {
      this.removeAbortListener(queued);
      queued.reject(reason);
    }
  }

  private canAcquireImmediately(chatId: number, userId?: number): boolean {
    return (
      this.active < this.maxConcurrent &&
      !this.queue.some((queued) => queued.chatId === chatId) &&
      this.isScopeFree(chatId, userId)
    );
  }

  private isScopeFree(chatId: number, userId?: number): boolean {
    return !this.activeChats.has(chatId) && (userId === undefined || !this.activeUsers.has(userId));
  }

  private grant(chatId: number, userId?: number): AiReplyPermit {
    this.active++;
    this.activeChats.add(chatId);
    if (userId !== undefined) this.activeUsers.add(userId);
    let released = false;

    return Object.freeze({
      release: () => {
        if (released) return;
        released = true;
        this.active--;
        this.activeChats.delete(chatId);
        if (userId !== undefined) this.activeUsers.delete(userId);
        this.drain();
      },
    });
  }

  private drain(): void {
    if (this.destroyed) return;

    while (this.active < this.maxConcurrent) {
      const index = this.findNextRunnableIndex();
      if (index === -1) return;

      const [queued] = this.queue.splice(index, 1);
      if (!queued) return;
      this.removeAbortListener(queued);
      if (queued.signal?.aborted) {
        queued.reject(queued.signal.reason ?? createAbortError());
        continue;
      }
      queued.resolve(this.grant(queued.chatId, queued.userId));
    }
  }

  private findNextRunnableIndex(): number {
    const seenChats = new Set<number>();
    for (const [index, queued] of this.queue.entries()) {
      if (seenChats.has(queued.chatId)) continue;
      seenChats.add(queued.chatId);
      if (this.isScopeFree(queued.chatId, queued.userId)) return index;
    }
    return -1;
  }

  private removeAbortListener(queued: QueuedAcquire): void {
    if (queued.signal && queued.onAbort) {
      queued.signal.removeEventListener("abort", queued.onAbort);
    }
  }
}

function createAbortError(): Error {
  const error = new Error("AI reply scheduling was aborted");
  error.name = "AbortError";
  return error;
}
