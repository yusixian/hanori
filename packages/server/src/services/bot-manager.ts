import type { BotConfig } from "@cos-tool-bot/bot";
import { createBot } from "@cos-tool-bot/bot";
import type { BotStatus } from "@cos-tool-bot/shared";
import type { Logger } from "pino";

export class BotManager {
  private bot: ReturnType<typeof createBot> | null = null;
  private config: BotConfig;
  private logger: Logger;
  private _status: BotStatus = "stopped";
  private startedAt: number | null = null;

  constructor(config: BotConfig) {
    this.config = {
      ...config,
      onRestart: () => this.restart(),
    };
    this.logger = config.logger;
  }

  get status(): BotStatus {
    return this._status;
  }

  get uptime(): number | null {
    if (!this.startedAt) return null;
    return Date.now() - this.startedAt;
  }

  async start() {
    if (this._status === "running") {
      this.logger.warn("Bot is already running");
      return;
    }

    this.bot = createBot(this.config);
    this._status = "running";
    this.startedAt = Date.now();

    this.bot.start({
      onStart: () => {
        this.logger.info("Bot started");
      },
    });
  }

  async stop() {
    if (!this.bot || this._status === "stopped") {
      this.logger.warn("Bot is not running");
      return;
    }

    this._status = "stopped";
    this.startedAt = null;
    this.bot.stop();
    this.bot = null;
    this.logger.info("Bot stopped");
  }

  async restart() {
    this._status = "restarting";
    this.logger.info("Bot restarting...");
    await this.stop();
    await this.start();
  }
}
