import type { Logger } from "pino";
import type { UsageGovernor } from "./usage-governor.js";
import { InFlightTasks } from "../utils/in-flight-tasks.js";

/** Periodic maintenance only; startup reconciliation stays awaited by the composition root. */
export class UsageMaintenanceService {
  private timers: ReturnType<typeof setInterval>[] = [];
  private readonly tasks = new InFlightTasks();
  private closing = false;
  private closeTask?: Promise<void>;

  constructor(
    private readonly governor: Pick<
      UsageGovernor,
      "pruneExpiredDetails" | "reclaimExpiredReservations"
    >,
    private readonly logger: Logger,
  ) {}

  start(): void {
    if (this.closing || this.timers.length) return;
    const schedule = (operation: () => Promise<unknown>, interval: number) => {
      const timer = setInterval(() => {
        if (!this.closing) void this.tasks.track(this.run(operation));
      }, interval);
      timer.unref();
      this.timers.push(timer);
    };
    schedule(() => this.governor.pruneExpiredDetails(), 24 * 60 * 60 * 1000);
    schedule(() => this.governor.reclaimExpiredReservations(), 60_000);
  }

  close(): Promise<void> {
    if (this.closeTask) return this.closeTask;
    this.closing = true;
    for (const timer of this.timers) clearInterval(timer);
    this.timers = [];
    this.closeTask = this.tasks.drain();
    return this.closeTask;
  }

  private async run(operation: () => Promise<unknown>): Promise<void> {
    try {
      await operation();
    } catch (error) {
      this.logger.error(error);
    }
  }
}
