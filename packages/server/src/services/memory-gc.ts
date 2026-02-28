import type { Database } from "@cos-tool-bot/database";
import { botMemories } from "@cos-tool-bot/database";
import { and, eq, lt } from "drizzle-orm";
import type { Logger } from "pino";

interface MemoryGCOptions {
  db: Database;
  logger: Logger;
  /** Days after which inactive memories are hard-deleted (default 30). */
  inactiveRetentionDays: number;
  /** How often to run GC in hours (default 24). */
  intervalHours: number;
}

/**
 * Periodic garbage collector for bot memories.
 * - Hard-deletes memories that have been inactive (`isActive = false`) for longer
 *   than `inactiveRetentionDays`.
 * Follows the same start/stop pattern as LogCleaner.
 */
export class MemoryGC {
  private db: Database;
  private logger: Logger;
  private inactiveRetentionDays: number;
  private intervalHours: number;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(options: MemoryGCOptions) {
    this.db = options.db;
    this.logger = options.logger;
    this.inactiveRetentionDays = options.inactiveRetentionDays;
    this.intervalHours = options.intervalHours;
  }

  start() {
    this.logger.info(
      {
        inactiveRetentionDays: this.inactiveRetentionDays,
        intervalHours: this.intervalHours,
      },
      "Memory GC started",
    );

    this.cleanup().catch(() => {});

    const intervalMs = Math.max(this.intervalHours, 1) * 60 * 60 * 1000;
    this.timer = setInterval(() => this.cleanup(), intervalMs);
    this.timer.unref();
  }

  stop() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  private async cleanup() {
    try {
      const cutoff = new Date(Date.now() - this.inactiveRetentionDays * 24 * 60 * 60 * 1000);

      // Hard-delete inactive memories older than retention period
      const deleted = await this.db
        .delete(botMemories)
        .where(and(eq(botMemories.isActive, false), lt(botMemories.updatedAt, cutoff)))
        .returning({ id: botMemories.id });

      if (deleted.length > 0) {
        this.logger.info({ deleted: deleted.length }, "Memory GC: deleted inactive memories");
      }
    } catch (err) {
      this.logger.error(err, "Memory GC cleanup failed");
    }
  }
}
