import type { Database } from "@cos-tool-bot/database";
import { botLogs } from "@cos-tool-bot/database";
import { and, lt, eq, ne } from "drizzle-orm";
import type { Logger } from "pino";

interface LogCleanerOptions {
  db: Database;
  logger: Logger;
  retentionDays: number;
  retentionDaysError: number;
  intervalHours: number;
}

export class LogCleaner {
  private db: Database;
  private logger: Logger;
  private retentionDays: number;
  private retentionDaysError: number;
  private intervalHours: number;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(options: LogCleanerOptions) {
    this.db = options.db;
    this.logger = options.logger;
    this.retentionDays = options.retentionDays;
    this.retentionDaysError = options.retentionDaysError;
    this.intervalHours = options.intervalHours;
  }

  start() {
    this.logger.info(
      { retentionDays: this.retentionDays, retentionDaysError: this.retentionDaysError, intervalHours: this.intervalHours },
      "Log cleaner started",
    );

    this.cleanup();

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
      const now = Date.now();

      const cutoff = new Date(now - this.retentionDays * 24 * 60 * 60 * 1000);
      const nonErrorResult = await this.db
        .delete(botLogs)
        .where(and(lt(botLogs.createdAt, cutoff), ne(botLogs.level, "error")));

      const errorCutoff = new Date(now - this.retentionDaysError * 24 * 60 * 60 * 1000);
      const errorResult = await this.db
        .delete(botLogs)
        .where(and(lt(botLogs.createdAt, errorCutoff), eq(botLogs.level, "error")));

      this.logger.info(
        { nonError: nonErrorResult.count, error: errorResult.count },
        "Log cleanup completed",
      );
    } catch (err) {
      this.logger.error(err, "Log cleanup failed");
    }
  }
}
