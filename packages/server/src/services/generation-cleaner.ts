import { unlink } from "node:fs/promises";
import path from "node:path";
import type { Database } from "@cos-tool-bot/database";
import { imageGenerations, pixaiGenerations } from "@cos-tool-bot/database";
import { getDataDir } from "@cos-tool-bot/shared";
import { and, inArray, lt } from "drizzle-orm";
import type { Logger } from "pino";

interface GenerationCleanerOptions {
  db: Database;
  logger: Logger;
  retentionDays: number;
  intervalHours: number;
}

export class GenerationCleaner {
  private db: Database;
  private logger: Logger;
  private retentionDays: number;
  private intervalHours: number;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(options: GenerationCleanerOptions) {
    this.db = options.db;
    this.logger = options.logger;
    this.retentionDays = options.retentionDays;
    this.intervalHours = options.intervalHours;
  }

  start() {
    this.logger.info(
      { retentionDays: this.retentionDays, intervalHours: this.intervalHours },
      "Generation cleaner started",
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

  getHandle(): ReturnType<typeof setInterval> | null {
    return this.timer;
  }

  getIntervalMs(): number {
    return Math.max(this.intervalHours, 1) * 60 * 60 * 1000;
  }

  async cleanup() {
    try {
      const cutoff = new Date(Date.now() - this.retentionDays * 24 * 60 * 60 * 1000);

      // Query expired records to get local file paths before deletion
      const [expiredLegacy, expiredCurrent] = await Promise.all([
        this.db
          .select({
            id: pixaiGenerations.id,
            botId: pixaiGenerations.botId,
            localFiles: pixaiGenerations.localFiles,
          })
          .from(pixaiGenerations)
          .where(lt(pixaiGenerations.createdAt, cutoff)),
        this.db
          .select({
            id: imageGenerations.id,
            botId: imageGenerations.botId,
            localFiles: imageGenerations.localFiles,
          })
          .from(imageGenerations)
          .where(
            and(
              lt(imageGenerations.createdAt, cutoff),
              inArray(imageGenerations.state, [
                "succeeded",
                "failed",
                "waiting_stopped",
                "attention_required",
                "cancelled",
              ]),
            ),
          ),
      ]);
      const expired = [...expiredLegacy, ...expiredCurrent];

      if (expired.length === 0) return;

      // Delete local image files
      let filesDeleted = 0;
      for (const record of expired) {
        if (!record.localFiles?.length) continue;
        const dir = path.join(getDataDir(record.botId), "generations");
        for (const filename of record.localFiles) {
          if (path.basename(filename) !== filename) continue;
          try {
            await unlink(path.join(dir, filename));
            filesDeleted++;
          } catch {
            // file may already be deleted
          }
        }
      }

      // Delete DB records
      const recordCount = expired.length;
      await Promise.all([
        this.db.delete(pixaiGenerations).where(lt(pixaiGenerations.createdAt, cutoff)),
        this.db
          .delete(imageGenerations)
          .where(
            and(
              lt(imageGenerations.createdAt, cutoff),
              inArray(imageGenerations.state, [
                "succeeded",
                "failed",
                "waiting_stopped",
                "attention_required",
                "cancelled",
              ]),
            ),
          ),
      ]);

      this.logger.info({ records: recordCount, filesDeleted }, "Generation cleanup completed");
    } catch (err) {
      this.logger.error(err, "Generation cleanup failed");
    }
  }
}
