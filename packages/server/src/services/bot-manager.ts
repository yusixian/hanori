import type { AiReplyBotConfig, BotConfig } from "@cos-tool-bot/bot";
import { createBot } from "@cos-tool-bot/bot";
import type { BotStatus, ConversationCallbacks } from "@cos-tool-bot/shared";
import type { Logger } from "pino";
import type { DbLogger } from "./db-logger.js";

interface BotManagerOptions {
  botId: string;
  token: string;
  adminChatIds: number[];
  logger: Logger;
  dbLogger: DbLogger;
  aiReply?: AiReplyBotConfig;
  conversation?: ConversationCallbacks;
  onBackup?: () => Promise<{ ok: boolean; filename?: string; error?: string }>;
}

export class BotManager {
  readonly botId: string;
  private bot: ReturnType<typeof createBot> | null = null;
  private botConfig: BotConfig;
  private dbLogger: DbLogger;
  private _status: BotStatus = "stopped";
  private startedAt: number | null = null;

  constructor(options: BotManagerOptions) {
    this.botId = options.botId;
    this.dbLogger = options.dbLogger;
    this.botConfig = {
      token: options.token,
      adminChatIds: options.adminChatIds,
      logger: options.logger,
      onRestart: () => this.restart(),
      onBackup: options.onBackup,
      onLog: (entry) => this.dbLogger.log(entry.level, entry.message, entry.meta),
      aiReply: options.aiReply,
      conversation: options.conversation,
    };
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
      await this.dbLogger.warn("Bot is already running");
      return;
    }

    this.bot = createBot(this.botConfig);
    this._status = "running";
    this.startedAt = Date.now();

    this.bot
      .start({
        onStart: () => {
          this.dbLogger.info("Bot started").catch(() => {});
        },
      })
      .catch((err) => {
        this._status = "stopped";
        this.startedAt = null;
        this.bot = null;
        this.dbLogger
          .error(`Bot crashed: ${err instanceof Error ? err.message : String(err)}`)
          .catch(() => {});
      });
  }

  async stop() {
    if (!this.bot || this._status === "stopped") {
      await this.dbLogger.warn("Bot is not running");
      return;
    }

    this._status = "stopped";
    this.startedAt = null;
    await this.bot.stop();
    this.bot = null;
    await this.dbLogger.info("Bot stopped");
  }

  async restart() {
    this._status = "restarting";
    await this.dbLogger.info("Bot restarting...");
    await this.stop();
    await this.start();
  }
}
