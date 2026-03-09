import type { BotStatus, IBotManager } from "@cos-tool-bot/shared";
import type { DbLogger } from "./db-logger.js";
import type { ImapEmailMonitor } from "./imap-email-monitor.js";
import type { LarkWebhookClient } from "./lark-webhook-client.js";

export interface LarkBotManagerOptions {
  botId: string;
  dbLogger: DbLogger;
  larkClient: LarkWebhookClient;
  emailMonitor?: ImapEmailMonitor;
}

export class LarkBotManager implements IBotManager {
  readonly botId: string;
  private dbLogger: DbLogger;
  private larkClient: LarkWebhookClient;
  private emailMonitor?: ImapEmailMonitor;
  private _status: BotStatus = "stopped";
  private startedAt: number | null = null;

  constructor(options: LarkBotManagerOptions) {
    this.botId = options.botId;
    this.dbLogger = options.dbLogger;
    this.larkClient = options.larkClient;
    this.emailMonitor = options.emailMonitor;
  }

  get status(): BotStatus {
    return this._status;
  }

  get uptime(): number | null {
    if (!this.startedAt) return null;
    return Date.now() - this.startedAt;
  }

  getLarkClient(): LarkWebhookClient {
    return this.larkClient;
  }

  async start(): Promise<void> {
    if (this._status === "running") {
      await this.dbLogger.warn("Lark webhook bot is already running");
      return;
    }

    this._status = "running";
    this.startedAt = Date.now();

    if (this.emailMonitor) {
      try {
        await this.emailMonitor.start();
        await this.dbLogger.info("Lark webhook bot started with email forwarding");
      } catch (err) {
        await this.dbLogger.warn(
          `Email monitor failed to start: ${err instanceof Error ? err.message : String(err)}`,
        );
        await this.dbLogger.info("Lark webhook bot started (email forwarding unavailable)");
      }
    } else {
      await this.dbLogger.info("Lark webhook bot started");
    }
  }

  async stop(): Promise<void> {
    if (this._status === "stopped") {
      await this.dbLogger.warn("Lark webhook bot is not running");
      return;
    }

    this._status = "stopped";
    this.startedAt = null;

    if (this.emailMonitor) {
      await this.emailMonitor.stop();
    }

    await this.dbLogger.info("Lark webhook bot stopped");
  }
}
