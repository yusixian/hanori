import { InFlightTasks } from "../utils/in-flight-tasks.js";
import { unlink } from "node:fs/promises";
import path from "node:path";
import type { Database } from "@cos-tool-bot/database";
import { imageGenerations, pixaiGenerations } from "@cos-tool-bot/database";
import { getDataDir } from "@cos-tool-bot/shared/file-validation";
import { and, eq, inArray, isNull, lt } from "drizzle-orm";
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

  private closing = false;
  private closeTask?: Promise<void>;
  private readonly tasks = new InFlightTasks();

  start() {
    if (this.closing || this.timer) return;
    this.logger.info(
      { retentionDays: this.retentionDays, intervalHours: this.intervalHours },
      "Generation cleaner started",
    );

    this.cleanup();

    const intervalMs = Math.max(this.intervalHours, 1) * 60 * 60 * 1000;
    this.timer = setInterval(() => this.cleanup(), intervalMs);
    this.timer.unref();
  }

  close(): Promise<void> {
    if (this.closeTask) return this.closeTask;
    this.closing = true;
    this.stop();
    this.closeTask = this.tasks.drain();
    return this.closeTask;
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

  cleanup(): Promise<void> {
    if (this.closing) return Promise.resolve();
    return this.tasks.track(this.cleanupImpl());
  }

  // Promise.all can reject before sibling Drizzle queries settle. Own each query too.
  private trackQuery<T>(query: PromiseLike<T>): Promise<T> {
    return this.tasks.track(Promise.resolve(query));
  }

  private async cleanupImpl() {
    try {
      const cutoff = new Date(Date.now() - this.retentionDays * 24 * 60 * 60 * 1000);

      // Generation metadata is an archive. Retention only purges expired binaries.
      const [expiredLegacy, expiredCurrent] = await Promise.all([
        this.trackQuery(
          this.db
            .select({
              id: pixaiGenerations.id,
              botId: pixaiGenerations.botId,
              localFiles: pixaiGenerations.localFiles,
            })
            .from(pixaiGenerations)
            .where(
              and(
                lt(pixaiGenerations.createdAt, cutoff),
                inArray(pixaiGenerations.status, ["completed", "failed"]),
                isNull(pixaiGenerations.filesPurgedAt),
              ),
            ),
        ),
        this.trackQuery(
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
                isNull(imageGenerations.filesPurgedAt),
              ),
            ),
        ),
      ]);
      const expired = [...expiredLegacy, ...expiredCurrent];

      if (expired.length === 0) return;

      // Delete local image files
      let filesDeleted = 0;
      const purged = new Set<(typeof expired)[number]>();
      for (const record of expired) {
        if (!record.localFiles?.length) {
          purged.add(record);
          continue;
        }
        let failed = false;
        const dir = path.join(getDataDir(record.botId), "generations");
        for (const filename of record.localFiles) {
          if (path.basename(filename) !== filename) continue;
          try {
            await unlink(path.join(dir, filename));
            filesDeleted++;
          } catch (err) {
            if ((err as NodeJS.ErrnoException).code === "ENOENT") continue;
            failed = true;
            this.logger.error({ err, generationId: record.id }, "Generation file cleanup failed");
          }
        }
        if (!failed) purged.add(record);
      }

      const recordCount = purged.size;
      const purgedAt = new Date();
      await Promise.all([
        ...expiredLegacy
          .filter((record) => purged.has(record))
          .map((record) =>
            this.trackQuery(
              this.db
                .update(pixaiGenerations)
                .set({ localFiles: null, filesPurgedAt: purgedAt })
                .where(eq(pixaiGenerations.id, record.id)),
            ),
          ),
        ...expiredCurrent
          .filter((record) => purged.has(record))
          .map((record) =>
            this.trackQuery(
              this.db
                .update(imageGenerations)
                .set({ localFiles: [], filesPurgedAt: purgedAt })
                .where(eq(imageGenerations.id, record.id)),
            ),
          ),
      ]);

      this.logger.info(
        { recordsPurged: recordCount, filesDeleted },
        "Generation cleanup completed",
      );
    } catch (err) {
      this.logger.error(err, "Generation cleanup failed");
    }
  }
}
