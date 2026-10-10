const CLEANUP_INTERVAL_MS = 60 * 60 * 1000;

interface RetentionBot {
  id: string;
  retentionDays: number;
}

interface RetentionDependencies {
  cleanup(botId: string, retentionDays: number): Promise<unknown>;
  listActiveBots(): Promise<RetentionBot[]>;
  warn(error: unknown, message: string): void;
}

/** Owns message-triggered and periodic cleanup, including shutdown draining. */
export class ConversationRetention {
  private lastCleanup = new Map<string, number>();
  private inFlight = new Map<string, Promise<void>>();
  private sweep?: Promise<void>;
  private timer?: ReturnType<typeof setInterval>;
  private stopped = false;

  constructor(private readonly dependencies: RetentionDependencies) {}

  trigger(botId: string, retentionDays: number): Promise<void> {
    return this.cleanup(botId, retentionDays);
  }

  start(activeBots: RetentionBot[]): void {
    this.stopped = false;
    if (!this.timer) {
      this.timer = setInterval(() => void this.runSweep(), CLEANUP_INTERVAL_MS);
      this.timer.unref();
    }
    void this.runSweep(activeBots, true);
  }

  async stop(): Promise<void> {
    this.stopped = true;
    clearInterval(this.timer);
    this.timer = undefined;
    await this.sweep;
    await Promise.all(this.inFlight.values());
  }

  private cleanup(botId: string, retentionDays: number, force = false): Promise<void> {
    if (this.stopped || retentionDays <= 0) return Promise.resolve();
    const existing = this.inFlight.get(botId);
    if (existing) return existing;
    const now = Date.now();
    const last = this.lastCleanup.get(botId);
    if (!force && last !== undefined && now - last < CLEANUP_INTERVAL_MS) return Promise.resolve();

    this.lastCleanup.set(botId, now);
    const task = Promise.resolve()
      .then(() => this.dependencies.cleanup(botId, retentionDays))
      .then(() => {})
      .catch((error) => {
        this.lastCleanup.delete(botId);
        this.dependencies.warn(error, `Conversation retention cleanup failed for bot=${botId}`);
      })
      .finally(() => this.inFlight.delete(botId));
    this.inFlight.set(botId, task);
    return task;
  }

  private runSweep(activeBots?: RetentionBot[], force = false): Promise<void> {
    if (this.stopped) return Promise.resolve();
    if (this.sweep) return this.sweep;
    const task = (async () => {
      const bots = activeBots ?? (await this.dependencies.listActiveBots());
      await Promise.all(bots.map((bot) => this.cleanup(bot.id, bot.retentionDays, force)));
    })()
      .catch((error) => this.dependencies.warn(error, "Conversation retention sweep failed"))
      .finally(() => {
        this.sweep = undefined;
      });
    this.sweep = task;
    return task;
  }
}
