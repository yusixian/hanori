import type { Database } from "@cos-tool-bot/database";
import { timers } from "@cos-tool-bot/database";
import type { TimerRecord, TimerStatus, TimerType } from "@cos-tool-bot/shared";
import { and, eq, lt, lte, or } from "drizzle-orm";
import type { Logger } from "pino";
import { InFlightTasks } from "../utils/in-flight-tasks.js";
import { KeyedAsyncLock } from "./keyed-async-lock.js";

export interface RegisteredTimer {
  id: string;
  botId: string | null;
  type: TimerType;
  name: string;
  chatId: number | null;
  status: TimerStatus;
  intervalMs: number | null;
  firesAt: Date | null;
  createdAt: Date;
  meta: Record<string, unknown> | null;
  handle?: ReturnType<typeof setTimeout>;
  isInterval?: boolean;
}

const CLEANUP_INTERVAL_MS = 5 * 60 * 1000; // 5 min
const COMPLETED_RETENTION_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
const DELIVERY_LEASE_MS = 60_000;
const DELIVERY_RETRY_MS = 5_000;
const MAX_TIMEOUT_MS = 2_147_483_647;
const LONG_TIMER_POLL_MS = 60_000;

export type TimerFireCallback = (
  timerId: string,
  botId: string,
  chatId: number,
  meta: Record<string, unknown> | null,
  delayed: boolean,
) => Promise<void>;

export interface TimerResumeResult {
  recovered: number;
  cancelled: number;
  immediate: number;
}

type TimerRow = typeof timers.$inferSelect;

function shortId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(8));
  return Array.from(bytes, (b) => b.toString(36).padStart(2, "0"))
    .join("")
    .slice(0, 12);
}

function toRecord(t: RegisteredTimer): TimerRecord {
  return {
    id: t.id,
    botId: t.botId,
    type: t.type,
    name: t.name,
    chatId: t.chatId,
    status: t.status,
    intervalMs: t.intervalMs,
    firesAt: t.firesAt?.toISOString() ?? null,
    createdAt: t.createdAt.toISOString(),
    firedAt: null,
    meta: t.meta,
  };
}

export class TimerRegistry {
  private closing = false;
  private closeTask?: Promise<void>;
  private readonly tasks = new InFlightTasks();
  private active = new Map<string, RegisteredTimer>();
  private registrationHandles = new Set<ReturnType<typeof setTimeout>>();
  private claimedPending = new Map<string, string>();
  private pausedBots = new Set<string>();
  private botLocks = new KeyedAsyncLock();
  private cleanupHandle: ReturnType<typeof setInterval>;
  private dbCleanupHandle: ReturnType<typeof setInterval>;
  private longTimerHandle: ReturnType<typeof setInterval>;
  private longTimers = new Map<
    string,
    {
      timer: RegisteredTimer;
      dueAt: number;
      onFire: TimerFireCallback;
      delayed: boolean;
      retryAllowed: boolean;
      alreadyClaimed: boolean;
    }
  >();

  constructor(
    private db: Database,
    private logger: Logger,
  ) {
    this.longTimerHandle = setInterval(() => {
      for (const [id, pending] of this.longTimers) {
        const remaining = pending.dueAt - Date.now();
        if (remaining > MAX_TIMEOUT_MS) continue;
        this.longTimers.delete(id);
        this.scheduleDelivery(
          pending.onFire,
          pending.timer,
          Math.max(0, remaining),
          pending.delayed,
          pending.retryAllowed,
          pending.alreadyClaimed,
        );
      }
    }, LONG_TIMER_POLL_MS);
    this.longTimerHandle.unref();
    this.cleanupHandle = setInterval(() => this.sweepExpired(), CLEANUP_INTERVAL_MS);
    this.cleanupHandle.unref();

    this.dbCleanupHandle = setInterval(
      () =>
        this.tasks.track(
          this.cleanupCompleted().catch((err) => {
            this.logger.error(err, "Unexpected timer DB cleanup error");
          }),
        ),
      CLEANUP_INTERVAL_MS,
    );
    this.dbCleanupHandle.unref();
  }

  /** Register a system timer (memory only, no DB). */
  registerSystem(opts: {
    name: string;
    intervalMs: number;
    handle: ReturnType<typeof setInterval>;
  }): string {
    const id = `sys_${shortId()}`;
    if (this.closing) {
      clearInterval(opts.handle);
      return id;
    }
    const timer: RegisteredTimer = {
      id,
      botId: null,
      type: "system",
      name: opts.name,
      chatId: null,
      status: "active",
      intervalMs: opts.intervalMs,
      firesAt: null,
      createdAt: new Date(),
      meta: null,
      handle: opts.handle as unknown as ReturnType<typeof setTimeout>,
      isInterval: true,
    };
    this.active.set(id, timer);
    return id;
  }

  /** Register an AI timer (memory + DB persist). Returns the timer ID. */
  async registerAi(opts: {
    timerId?: string;
    botId: string;
    chatId: number;
    name: string;
    seconds: number;
    meta?: Record<string, unknown>;
    handle?: ReturnType<typeof setTimeout>;
    onFire?: TimerFireCallback;
  }): Promise<string> {
    if (this.closing && opts.handle) clearTimeout(opts.handle);
    return this.run(() => {
      if (opts.handle) this.registrationHandles.add(opts.handle);
      return this.registerAiImpl(opts).finally(() => {
        if (opts.handle) {
          this.registrationHandles.delete(opts.handle);
        }
      });
    });
  }

  private async registerAiImpl(opts: Parameters<TimerRegistry["registerAi"]>[0]): Promise<string> {
    return this.botLocks.run(opts.botId, async () => {
      const id = opts.timerId ?? `ai_${shortId()}`;
      const firesAt = new Date(Date.now() + opts.seconds * 1000);
      const timer: RegisteredTimer = {
        id,
        botId: opts.botId,
        type: "ai",
        name: opts.name,
        chatId: opts.chatId,
        status: "active",
        intervalMs: null,
        firesAt,
        createdAt: new Date(),
        meta: opts.meta ?? null,
        handle: opts.handle,
      };
      const paused = this.pausedBots.has(opts.botId);

      try {
        await this.db.insert(timers).values({
          id: timer.id,
          botId: timer.botId,
          type: timer.type,
          name: timer.name,
          chatId: timer.chatId,
          status: timer.status,
          firesAt: timer.firesAt,
          meta: timer.meta,
        });
      } catch (err) {
        this.logger.error(err, `Failed to persist AI timer ${id}`);
        if (opts.onFire) throw err;
      }

      if ((this.closing || paused || opts.onFire) && timer.handle) clearTimeout(timer.handle);
      if (!this.closing && !paused) {
        if (opts.onFire) {
          const delay = Math.max(0, firesAt.getTime() - Date.now());
          this.scheduleDelivery(opts.onFire, timer, delay, false, true);
        } else {
          this.active.set(id, timer);
        }
      }

      return id;
    });
  }

  /** Set the setTimeout handle for an AI timer (called after registerAi). */
  setHandle(timerId: string, handle: ReturnType<typeof setTimeout>): void {
    if (this.closing) {
      clearTimeout(handle);
      return;
    }
    const t = this.active.get(timerId);
    if (t) t.handle = handle;
  }

  /** Look up a timer by ID. */
  get(timerId: string): RegisteredTimer | undefined {
    return this.active.get(timerId);
  }

  /** Mark a timer as fired. */
  markFired(timerId: string): Promise<void> {
    return this.run(() => this.markFiredImpl(timerId));
  }

  private async markFiredImpl(timerId: string): Promise<void> {
    const t = this.active.get(timerId);
    try {
      if (t) {
        t.status = "fired";
        this.active.delete(timerId);
      }
      if (!timerId.startsWith("sys_")) {
        await this.db
          .update(timers)
          .set({ status: "fired", firedAt: new Date() })
          .where(and(eq(timers.id, timerId), eq(timers.status, "active")));
      }
    } catch (err) {
      this.logger.error(err, `Failed to mark timer ${timerId} as fired`);
      this.active.delete(timerId);
      throw err;
    }
  }

  /** Cancel a timer. */
  cancel(timerId: string): Promise<boolean> {
    return this.run(() => this.cancelImpl(timerId));
  }

  private async cancelImpl(timerId: string): Promise<boolean> {
    const t = this.active.get(timerId);
    if (!t) return false;

    const cancel = async () => {
      if (this.active.get(timerId) !== t) return false;
      if (!timerId.startsWith("sys_")) {
        try {
          await this.db.update(timers).set({ status: "cancelled" }).where(eq(timers.id, timerId));
        } catch (err) {
          this.logger.error(err, `Failed to persist timer cancel ${timerId}`);
          throw err;
        }
      }
      if (t.handle) {
        if (t.isInterval) clearInterval(t.handle);
        else clearTimeout(t.handle);
      }
      t.status = "cancelled";
      this.active.delete(timerId);
      this.claimedPending.delete(timerId);
      this.longTimers.delete(timerId);
      return true;
    };
    return t.botId ? this.botLocks.run(t.botId, cancel) : cancel();
  }

  /** List all active timers, optionally filtered. */
  listActive(filter?: { botId?: string; type?: TimerType }): TimerRecord[] {
    const result: TimerRecord[] = [];
    for (const t of this.active.values()) {
      if (t.status !== "active") continue;
      if (filter?.botId && t.botId !== filter.botId) continue;
      if (filter?.type && t.type !== filter.type) continue;
      result.push(toRecord(t));
    }
    return result;
  }

  /** Clear one Bot's in-memory schedules without changing durable timer state. */
  pauseBot(botId: string): Promise<number> {
    return this.botLocks.run(botId, async () => this.pauseBotUnlocked(botId));
  }

  /** Rebuild one running Bot's schedules from durable active timers. */
  resumeBot(botId: string, onFire: TimerFireCallback): Promise<TimerResumeResult> {
    return this.run(() => this.resumeBotImpl(botId, onFire));
  }

  private async resumeBotImpl(
    botId: string,
    onFire: TimerFireCallback,
  ): Promise<TimerResumeResult> {
    const rows = await this.botLocks.run(botId, async () => {
      this.pauseBotUnlocked(botId);
      this.pausedBots.delete(botId);
      try {
        return await this.db
          .select()
          .from(timers)
          .where(
            and(
              eq(timers.botId, botId),
              eq(timers.type, "ai"),
              or(eq(timers.status, "active"), eq(timers.status, "processing")),
            ),
          );
      } catch (err) {
        this.logger.error(err, `Failed to resume AI timers for bot ${botId}`);
        this.pausedBots.add(botId);
        throw err;
      }
    });
    return this.restoreRows(botId, rows, onFire);
  }

  private pauseBotUnlocked(botId: string): number {
    this.pausedBots.add(botId);
    let paused = 0;
    for (const [id, timer] of this.active) {
      if (timer.botId !== botId) continue;
      if (timer.handle) clearTimeout(timer.handle);
      this.active.delete(id);
      this.claimedPending.delete(id);
      this.longTimers.delete(id);
      paused++;
    }
    return paused;
  }

  private async restoreRows(
    botId: string,
    rows: TimerRow[],
    onFire: TimerFireCallback,
  ): Promise<TimerResumeResult> {
    let recovered = 0;
    let cancelled = 0;
    let immediate = 0;
    const now = Date.now();

    for (const row of rows) {
      if (this.closing) break;
      if (!row.firesAt || row.chatId == null) {
        if (await this.cancelActive(row.id, botId)) cancelled++;
        continue;
      }

      const timer: RegisteredTimer = {
        id: row.id,
        botId,
        type: "ai",
        name: row.name,
        chatId: row.chatId,
        status: "active",
        intervalMs: null,
        firesAt: row.firesAt,
        createdAt: row.createdAt,
        meta: row.meta as Record<string, unknown> | null,
      };
      const leaseDelay =
        row.status === "processing" && row.firedAt
          ? row.firedAt.getTime() + DELIVERY_LEASE_MS - now
          : 0;
      const delay = Math.max(row.firesAt.getTime() - now, leaseDelay);
      if (delay <= 0) {
        if (await this.claimForDelivery(row.id, botId)) {
          if (this.closing) {
            await this.rollbackClaim(row.id, botId);
            break;
          }
          immediate++;
          this.scheduleDelivery(onFire, timer, 0, true, true, true);
        }
        continue;
      }
      this.scheduleDelivery(onFire, timer, delay, false, true);
      recovered++;
    }
    return { recovered, cancelled, immediate };
  }

  private async deliver(
    onFire: TimerFireCallback,
    timer: RegisteredTimer,
    delayed: boolean,
    retryAllowed: boolean,
  ): Promise<void> {
    try {
      await onFire(timer.id, timer.botId!, timer.chatId!, timer.meta, delayed);
      await this.completeDelivery(timer.id, timer.botId!);
    } catch (err) {
      this.logger.error(err, `Failed to deliver resumed timer ${timer.id}`);
      if (retryAllowed && (await this.rollbackClaim(timer.id, timer.botId!))) {
        this.scheduleDelivery(onFire, timer, DELIVERY_RETRY_MS, true, false);
      } else if (!retryAllowed) {
        await this.rollbackClaim(timer.id, timer.botId!);
      }
    }
  }

  private scheduleDelivery(
    onFire: TimerFireCallback,
    timer: RegisteredTimer,
    delay: number,
    delayed: boolean,
    retryAllowed: boolean,
    alreadyClaimed = false,
  ): void {
    if (this.closing || this.pausedBots.has(timer.botId!)) return;
    if (alreadyClaimed) this.claimedPending.set(timer.id, timer.botId!);
    // A single registry sweep checks persisted absolute deadlines until Node can
    // represent the remaining delay. Never hand an overflowing delay to setTimeout.
    if (delay > MAX_TIMEOUT_MS) {
      this.longTimers.set(timer.id, {
        timer,
        dueAt: Date.now() + delay,
        onFire,
        delayed,
        retryAllowed,
        alreadyClaimed,
      });
      this.active.set(timer.id, timer);
      return;
    }
    const handle = setTimeout(() => {
      if (!this.closing) {
        void this.tasks.track(
          this.beginDelivery(onFire, timer, delayed, retryAllowed, alreadyClaimed),
        );
      }
    }, delay);
    handle.unref();
    timer.status = "active";
    timer.handle = handle;
    this.active.set(timer.id, timer);
  }

  private async beginDelivery(
    onFire: TimerFireCallback,
    timer: RegisteredTimer,
    delayed: boolean,
    retryAllowed: boolean,
    alreadyClaimed: boolean,
  ): Promise<void> {
    try {
      const claimed = await this.botLocks.run(timer.botId!, async () => {
        this.claimedPending.delete(timer.id);
        if (this.active.get(timer.id) !== timer || this.pausedBots.has(timer.botId!)) return false;
        this.active.delete(timer.id);
        return alreadyClaimed || this.claimForDelivery(timer.id, timer.botId!);
      });
      if (claimed) await this.deliver(onFire, timer, delayed, retryAllowed);
    } catch (err) {
      this.logger.error(err, `Failed to fire resumed timer ${timer.id}`);
    }
  }

  private async rollbackClaim(timerId: string, botId: string): Promise<boolean> {
    try {
      const restored = await this.db
        .update(timers)
        .set({ status: "active", firedAt: null })
        .where(
          and(
            eq(timers.id, timerId),
            eq(timers.botId, botId),
            eq(timers.type, "ai"),
            eq(timers.status, "processing"),
          ),
        )
        .returning({ id: timers.id });
      return restored.length === 1;
    } catch (err) {
      this.logger.error(err, `Failed to restore timer ${timerId} after delivery failure`);
      return false;
    }
  }

  private async claimForDelivery(timerId: string, botId: string): Promise<boolean> {
    try {
      const claimedAt = new Date();
      const claimed = await this.db
        .update(timers)
        .set({ status: "processing", firedAt: claimedAt })
        .where(
          and(
            eq(timers.id, timerId),
            eq(timers.botId, botId),
            eq(timers.type, "ai"),
            or(
              eq(timers.status, "active"),
              and(
                eq(timers.status, "processing"),
                lte(timers.firedAt, new Date(claimedAt.getTime() - DELIVERY_LEASE_MS)),
              ),
            ),
          ),
        )
        .returning({ id: timers.id });
      return claimed.length === 1;
    } catch (err) {
      this.logger.error(err, `Failed to claim active timer ${timerId}`);
      return false;
    }
  }

  private async completeDelivery(timerId: string, botId: string): Promise<void> {
    const completed = await this.db
      .update(timers)
      .set({ status: "fired", firedAt: new Date() })
      .where(
        and(
          eq(timers.id, timerId),
          eq(timers.botId, botId),
          eq(timers.type, "ai"),
          eq(timers.status, "processing"),
        ),
      )
      .returning({ id: timers.id });
    if (completed.length !== 1) throw new Error(`Timer ${timerId} delivery could not be finalized`);
  }

  private async cancelActive(timerId: string, botId: string): Promise<boolean> {
    try {
      const cancelled = await this.db
        .update(timers)
        .set({ status: "cancelled" })
        .where(and(eq(timers.id, timerId), eq(timers.botId, botId), eq(timers.status, "active")))
        .returning({ id: timers.id });
      return cancelled.length === 1;
    } catch (err) {
      this.logger.error(err, `Failed to cancel invalid active timer ${timerId}`);
      return false;
    }
  }

  /** Cleanup completed/cancelled timer records older than 7 days. */
  private async cleanupCompleted(): Promise<void> {
    try {
      const cutoff = new Date(Date.now() - COMPLETED_RETENTION_MS);
      const deleted = await this.db
        .delete(timers)
        .where(
          and(
            or(eq(timers.status, "fired"), eq(timers.status, "cancelled")),
            lt(timers.createdAt, cutoff),
          ),
        )
        .returning({ id: timers.id });
      if (deleted.length > 0) {
        this.logger.info({ deleted: deleted.length }, "Timer DB cleanup completed");
      }
    } catch (err) {
      this.logger.error(err, "Timer DB cleanup failed");
    }
  }

  /** Sweep memory map for expired entries that weren't properly cleaned up. */
  private sweepExpired(): void {
    const now = Date.now();
    for (const [id, t] of this.active) {
      if (t.type === "ai" && t.firesAt && t.firesAt.getTime() < now - CLEANUP_INTERVAL_MS) {
        // Expiry alone cannot prove Telegram delivery. A rejected delivery intentionally
        // leaves the durable row active so the next Bot start can recover it.
        this.active.delete(id);
        this.claimedPending.delete(id);
      }
    }
  }

  private run<T>(operation: () => Promise<T>): Promise<T> {
    if (this.closing) return Promise.reject(new Error("Timer registry is closing"));
    return this.tasks.track(operation());
  }

  close(): Promise<void> {
    if (this.closeTask) return this.closeTask;
    this.destroy();
    this.closeTask = this.tasks.drain();
    return this.closeTask;
  }

  /** Stop scheduling synchronously; close also waits for admitted work. */
  destroy(): void {
    this.closing = true;
    for (const handle of this.registrationHandles) clearTimeout(handle);
    this.registrationHandles.clear();
    clearInterval(this.cleanupHandle);
    clearInterval(this.dbCleanupHandle);
    clearInterval(this.longTimerHandle);
    this.longTimers.clear();
    for (const t of this.active.values()) {
      if (t.handle) {
        if (t.isInterval) clearInterval(t.handle);
        else clearTimeout(t.handle);
      }
    }
    this.active.clear();
    for (const [timerId, botId] of this.claimedPending) {
      void this.tasks.track(this.rollbackClaim(timerId, botId));
    }
    this.claimedPending.clear();
    this.pausedBots.clear();
  }
}
