import type { Database } from "@cos-tool-bot/database";
import { timers } from "@cos-tool-bot/database";
import type { TimerRecord, TimerStatus, TimerType } from "@cos-tool-bot/shared";
import { and, eq, lt, ne } from "drizzle-orm";
import type { Logger } from "pino";

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
const MAX_RECOVERY_WINDOW_MS = 24 * 60 * 60 * 1000; // 24 hours

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
  private active = new Map<string, RegisteredTimer>();
  private cleanupHandle: ReturnType<typeof setInterval>;
  private dbCleanupHandle: ReturnType<typeof setInterval>;

  constructor(
    private db: Database,
    private logger: Logger,
  ) {
    this.cleanupHandle = setInterval(() => this.sweepExpired(), CLEANUP_INTERVAL_MS);
    this.cleanupHandle.unref();

    this.dbCleanupHandle = setInterval(
      () =>
        this.cleanupCompleted().catch((err) => {
          this.logger.error(err, "Unexpected timer DB cleanup error");
        }),
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
  }): Promise<string> {
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
    };
    this.active.set(id, timer);

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
    }

    return id;
  }

  /** Set the setTimeout handle for an AI timer (called after registerAi). */
  setHandle(timerId: string, handle: ReturnType<typeof setTimeout>): void {
    const t = this.active.get(timerId);
    if (t) t.handle = handle;
  }

  /** Look up a timer by ID. */
  get(timerId: string): RegisteredTimer | undefined {
    return this.active.get(timerId);
  }

  /** Mark a timer as fired. */
  async markFired(timerId: string): Promise<void> {
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
          .where(eq(timers.id, timerId));
      }
    } catch (err) {
      this.logger.error(err, `Failed to mark timer ${timerId} as fired`);
      this.active.delete(timerId);
    }
  }

  /** Cancel a timer. */
  async cancel(timerId: string): Promise<boolean> {
    const t = this.active.get(timerId);
    if (!t) return false;

    if (t.handle) {
      if (t.isInterval) clearInterval(t.handle);
      else clearTimeout(t.handle);
    }
    t.status = "cancelled";
    this.active.delete(timerId);

    if (!timerId.startsWith("sys_")) {
      try {
        await this.db.update(timers).set({ status: "cancelled" }).where(eq(timers.id, timerId));
      } catch (err) {
        this.logger.error(err, `Failed to persist timer cancel ${timerId}`);
      }
    }
    return true;
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

  /** Recover AI timers from DB after restart. */
  async recoverAiTimers(
    onFire: (
      timerId: string,
      botId: string,
      chatId: number,
      meta: Record<string, unknown> | null,
    ) => void,
    isRunning: (botId: string) => boolean,
  ): Promise<{ recovered: number; cancelled: number; immediate: number }> {
    let recovered = 0;
    let cancelled = 0;
    let immediate = 0;

    try {
      const rows = await this.db
        .select()
        .from(timers)
        .where(and(eq(timers.type, "ai"), eq(timers.status, "active")));

      const now = Date.now();

      for (const row of rows) {
        if (!row.botId || !row.firesAt || row.chatId == null) {
          await this.db.update(timers).set({ status: "cancelled" }).where(eq(timers.id, row.id));
          cancelled++;
          continue;
        }

        // Bot not running → cancel
        if (!isRunning(row.botId)) {
          await this.db.update(timers).set({ status: "cancelled" }).where(eq(timers.id, row.id));
          this.logger.info(`Timer ${row.id} cancelled: bot ${row.botId} not running`);
          cancelled++;
          continue;
        }

        const fireTime = row.firesAt.getTime();
        const elapsed = now - fireTime;

        if (elapsed > MAX_RECOVERY_WINDOW_MS) {
          // Too old → cancel
          await this.db.update(timers).set({ status: "cancelled" }).where(eq(timers.id, row.id));
          this.logger.info(`Timer ${row.id} cancelled: expired >24h ago`);
          cancelled++;
          continue;
        }

        const timer: RegisteredTimer = {
          id: row.id,
          botId: row.botId,
          type: "ai",
          name: row.name,
          chatId: row.chatId,
          status: "active",
          intervalMs: null,
          firesAt: row.firesAt,
          createdAt: row.createdAt,
          meta: row.meta as Record<string, unknown> | null,
        };
        this.active.set(row.id, timer);

        if (elapsed > 0) {
          // Past due but within 24h → fire after a short delay to ensure bot handlers are ready
          immediate++;
          const handle = setTimeout(() => {
            onFire(row.id, row.botId!, row.chatId!, timer.meta);
          }, 2000);
          handle.unref();
          timer.handle = handle;
        } else {
          // Future → rebuild setTimeout
          const delay = -elapsed;
          const handle = setTimeout(() => {
            onFire(row.id, row.botId!, row.chatId!, timer.meta);
          }, delay);
          handle.unref();
          timer.handle = handle;
          recovered++;
        }
      }
    } catch (err) {
      this.logger.error(err, "Failed to recover AI timers");
    }

    if (recovered + cancelled + immediate > 0) {
      this.logger.info({ recovered, cancelled, immediate }, "AI timer recovery complete");
    }
    return { recovered, cancelled, immediate };
  }

  /** Cleanup completed/cancelled timer records older than 7 days. */
  private async cleanupCompleted(): Promise<void> {
    try {
      const cutoff = new Date(Date.now() - COMPLETED_RETENTION_MS);
      const deleted = await this.db
        .delete(timers)
        .where(and(ne(timers.status, "active"), lt(timers.createdAt, cutoff)))
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
    const staleIds: string[] = [];
    for (const [id, t] of this.active) {
      if (t.type === "ai" && t.firesAt && t.firesAt.getTime() < now - CLEANUP_INTERVAL_MS) {
        // AI timer past due by >5min but still in map → remove
        this.active.delete(id);
        staleIds.push(id);
      }
    }
    // Sync stale timers to DB so they won't be recovered on restart
    if (staleIds.length > 0) {
      Promise.all(
        staleIds.map((id) =>
          this.db
            .update(timers)
            .set({ status: "fired", firedAt: new Date() })
            .where(eq(timers.id, id)),
        ),
      ).catch((err) => {
        this.logger.error(err, "Failed to mark swept timers as fired in DB");
      });
    }
  }

  /** Destroy all handles for graceful shutdown. */
  destroy(): void {
    clearInterval(this.cleanupHandle);
    clearInterval(this.dbCleanupHandle);
    for (const t of this.active.values()) {
      if (t.handle) {
        if (t.isInterval) clearInterval(t.handle);
        else clearTimeout(t.handle);
      }
    }
    this.active.clear();
  }
}
