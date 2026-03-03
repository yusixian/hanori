import type { PixAIRateLimitConfig } from "@cos-tool-bot/shared";
import { DEFAULT_PIXAI_RATE_LIMIT } from "@cos-tool-bot/shared";

export type RateLimitDenyReason =
  | "user_cooldown"
  | "chat_cooldown"
  | "hourly_exceeded"
  | "concurrent_full"
  | "queue_full";

export interface RateLimitResult {
  allowed: boolean;
  reason?: RateLimitDenyReason;
  /** Remaining cooldown seconds (for user_cooldown / chat_cooldown) */
  cooldownSec?: number;
  /** Hourly usage info (for hourly_exceeded) */
  hourlyUsed?: number;
  hourlyLimit?: number;
}

export interface RateLimitStats {
  active: number;
  maxConcurrent: number;
  queued: number;
  maxQueue: number;
  hourlyUsed: number;
  hourlyLimit: number;
}

interface ActiveTask {
  chatId: number;
  userId: number | undefined;
  startedAt: number;
}

interface QueuedRequest {
  chatId: number;
  userId: number | undefined;
  isAdmin: boolean;
  resolve: () => void;
  reject: (err: Error) => void;
}

const STALE_TASK_MS = 15 * 60 * 1000; // 15 minutes

export class PixAIRateLimiter {
  private config: Required<PixAIRateLimitConfig>;
  private activeTasks = new Map<string, ActiveTask>();
  private userCooldowns = new Map<number, number>();
  private chatCooldowns = new Map<number, number>();
  private hourlyLog: number[] = [];
  private queue: QueuedRequest[] = [];

  constructor(config?: PixAIRateLimitConfig) {
    this.config = { ...DEFAULT_PIXAI_RATE_LIMIT, ...config };
  }

  /** Check if a request would be allowed (without acquiring) */
  check(chatId: number, userId: number | undefined, isAdmin: boolean): RateLimitResult {
    // Admin bypass
    if (isAdmin && this.config.adminBypass) {
      return { allowed: true };
    }

    // User cooldown
    if (userId != null) {
      const lastTime = this.userCooldowns.get(userId);
      if (lastTime != null) {
        const elapsed = (Date.now() - lastTime) / 1000;
        if (elapsed < this.config.userCooldownSec) {
          return {
            allowed: false,
            reason: "user_cooldown",
            cooldownSec: Math.ceil(this.config.userCooldownSec - elapsed),
          };
        }
      }
    }

    // Chat cooldown
    const lastChatTime = this.chatCooldowns.get(chatId);
    if (lastChatTime != null) {
      const elapsed = (Date.now() - lastChatTime) / 1000;
      if (elapsed < this.config.chatCooldownSec) {
        return {
          allowed: false,
          reason: "chat_cooldown",
          cooldownSec: Math.ceil(this.config.chatCooldownSec - elapsed),
        };
      }
    }

    // Hourly limit
    const now = Date.now();
    const hourAgo = now - 3600_000;
    const hourlyUsed = this.hourlyLog.filter((t) => t > hourAgo).length;
    if (hourlyUsed >= this.config.hourlyLimit) {
      return {
        allowed: false,
        reason: "hourly_exceeded",
        hourlyUsed,
        hourlyLimit: this.config.hourlyLimit,
      };
    }

    // Concurrent check
    if (this.activeTasks.size >= this.config.maxConcurrentTasks) {
      return { allowed: false, reason: "concurrent_full" };
    }

    return { allowed: true };
  }

  /**
   * Try to acquire a slot. On success, records cooldowns and hourly log.
   * Returns the check result — caller should proceed only if allowed.
   */
  tryAcquire(chatId: number, userId: number | undefined, isAdmin: boolean): RateLimitResult {
    const result = this.check(chatId, userId, isAdmin);
    if (!result.allowed) return result;

    // Record cooldowns (from submission time)
    const now = Date.now();
    if (userId != null) this.userCooldowns.set(userId, now);
    this.chatCooldowns.set(chatId, now);

    // Non-admin: record in hourly log
    if (!isAdmin || !this.config.adminBypass) {
      this.hourlyLog.push(now);
    }

    return result;
  }

  /**
   * Enqueue a request when concurrent slots are full.
   * Returns a promise that resolves when a slot becomes available, or null if queue is full.
   */
  enqueue(
    chatId: number,
    userId: number | undefined,
    isAdmin: boolean,
  ): { promise: Promise<void>; position: number } | null {
    if (this.queue.length >= this.config.maxQueueDepth) {
      return null;
    }

    let resolve!: () => void;
    let reject!: (err: Error) => void;
    const promise = new Promise<void>((res, rej) => {
      resolve = res;
      reject = rej;
    });

    this.queue.push({ chatId, userId, isAdmin, resolve, reject });
    return { promise, position: this.queue.length };
  }

  /** Register an active task (call after createTask succeeds) */
  registerTask(taskId: string, chatId: number, userId: number | undefined): void {
    this.activeTasks.set(taskId, { chatId, userId, startedAt: Date.now() });
  }

  /** Release a completed/failed task and try to process queued requests */
  releaseTask(taskId: string): void {
    this.activeTasks.delete(taskId);
    this.processQueue();
  }

  /** Update config at runtime */
  updateConfig(partial: Partial<PixAIRateLimitConfig>): void {
    Object.assign(this.config, partial);
  }

  /** Get current config */
  getConfig(): Required<PixAIRateLimitConfig> {
    return { ...this.config };
  }

  /** Get runtime stats */
  getStats(): RateLimitStats {
    const now = Date.now();
    const hourAgo = now - 3600_000;
    return {
      active: this.activeTasks.size,
      maxConcurrent: this.config.maxConcurrentTasks,
      queued: this.queue.length,
      maxQueue: this.config.maxQueueDepth,
      hourlyUsed: this.hourlyLog.filter((t) => t > hourAgo).length,
      hourlyLimit: this.config.hourlyLimit,
    };
  }

  /** Cleanup expired state: cooldowns, hourly log, stale tasks */
  cleanup(): void {
    const now = Date.now();
    const hourAgo = now - 3600_000;

    // Trim hourly log
    this.hourlyLog = this.hourlyLog.filter((t) => t > hourAgo);

    // Clean expired user cooldowns
    for (const [userId, ts] of this.userCooldowns) {
      if (now - ts > this.config.userCooldownSec * 1000) {
        this.userCooldowns.delete(userId);
      }
    }

    // Clean expired chat cooldowns
    for (const [chatId, ts] of this.chatCooldowns) {
      if (now - ts > this.config.chatCooldownSec * 1000) {
        this.chatCooldowns.delete(chatId);
      }
    }

    // Clean stale tasks (stuck > 15 min)
    for (const [taskId, task] of this.activeTasks) {
      if (now - task.startedAt > STALE_TASK_MS) {
        this.activeTasks.delete(taskId);
      }
    }

    // Process queue after cleaning stale tasks
    if (this.queue.length > 0) {
      this.processQueue();
    }
  }

  /** Reject all queued requests (e.g. on bot shutdown) */
  dispose(): void {
    for (const req of this.queue) {
      req.reject(new Error("Rate limiter disposed"));
    }
    this.queue = [];
    this.activeTasks.clear();
  }

  // --- Private ---

  private processQueue(): void {
    while (this.queue.length > 0 && this.activeTasks.size < this.config.maxConcurrentTasks) {
      const req = this.queue[0]!;

      // Re-check cooldowns and hourly limit (skip admin bypass check — they wouldn't be queued)
      const checkResult = this.check(req.chatId, req.userId, req.isAdmin);
      if (!checkResult.allowed && checkResult.reason !== "concurrent_full") {
        // Still blocked by cooldown/hourly — keep in queue, try next
        // Move to back of queue to avoid blocking others
        this.queue.shift();
        this.queue.push(req);
        // If we've cycled through all requests without resolving any, break
        break;
      }

      // Slot available — dequeue and resolve
      this.queue.shift();

      // Record cooldowns for the queued request
      const now = Date.now();
      if (req.userId != null) this.userCooldowns.set(req.userId, now);
      this.chatCooldowns.set(req.chatId, now);
      if (!req.isAdmin || !this.config.adminBypass) {
        this.hourlyLog.push(now);
      }

      req.resolve();
    }
  }
}
