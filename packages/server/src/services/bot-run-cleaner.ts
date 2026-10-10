import { InFlightTasks } from "../utils/in-flight-tasks.js";
import type { Database } from "@cos-tool-bot/database";
import { botRuns } from "@cos-tool-bot/database";
import { and, eq, lt, ne, or } from "drizzle-orm";
import type { Logger } from "pino";

export class BotRunCleaner {
  private timer?: ReturnType<typeof setInterval>;

  constructor(
    private db: Database,
    private logger: Logger,
    private successDays = 7,
    private failureDays = 30,
  ) {}

  private closing = false;
  private closeTask?: Promise<void>;
  private readonly tasks = new InFlightTasks();

  start() {
    if (this.closing || this.timer) return;
    void this.clean();
    this.timer = setInterval(() => void this.clean(), 24 * 60 * 60 * 1000);
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
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  clean(now = Date.now()): Promise<void> {
    if (this.closing) return Promise.resolve();
    return this.tasks.track(this.cleanImpl(now));
  }

  private async cleanImpl(now: number) {
    try {
      const successCutoff = new Date(now - this.successDays * 86_400_000);
      const failureCutoff = new Date(now - this.failureDays * 86_400_000);
      const result = await this.db
        .delete(botRuns)
        .where(
          and(
            eq(botRuns.pinned, false),
            or(
              and(eq(botRuns.status, "succeeded"), lt(botRuns.createdAt, successCutoff)),
              and(ne(botRuns.status, "succeeded"), lt(botRuns.createdAt, failureCutoff)),
            ),
          ),
        );
      this.logger.debug({ deleted: result.count }, "Bot Run cleanup completed");
    } catch (error) {
      this.logger.error(error, "Bot Run cleanup failed");
    }
  }
}
