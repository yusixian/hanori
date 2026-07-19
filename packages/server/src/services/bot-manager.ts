import type {
  AiReplyBotConfig,
  BotConfig,
  McpCommandConfig,
  SummaryCallbacks,
  TimerCallbacks,
} from "@cos-tool-bot/bot";
import { createBot, recoverPixAIGeneration } from "@cos-tool-bot/bot";
import { run, type RunnerHandle } from "@grammyjs/runner";
import type {
  BotStatus,
  ConversationCallbacks,
  IBotManager,
  PixAIGenerationRecord,
  TelegramRichMessageFormat,
  TelegramRichMessageReceipt,
  TokenUsageRecord,
} from "@cos-tool-bot/shared";
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
  onRestart?: () => void | Promise<void>;
  onBackup?: () => Promise<{ ok: boolean; filename?: string; error?: string }>;
  onTokenUsage?: (entry: TokenUsageRecord) => void | Promise<void>;
  onGenerationTrack?: (record: PixAIGenerationRecord) => void | Promise<void>;
  timerCallbacks?: TimerCallbacks;
  mcpCallbacks?: McpCommandConfig;
  summary?: SummaryCallbacks;
}

export class BotManager implements IBotManager {
  readonly botId: string;
  private bot: ReturnType<typeof createBot> | null = null;
  private runnerHandle: RunnerHandle | null = null;
  private botConfig: BotConfig;
  private dbLogger: DbLogger;
  private _status: BotStatus = "stopped";
  private startedAt: number | null = null;

  constructor(options: BotManagerOptions) {
    this.botId = options.botId;
    this.dbLogger = options.dbLogger;
    this.botConfig = {
      token: options.token,
      botId: options.botId,
      adminChatIds: options.adminChatIds,
      logger: options.logger,
      onRestart: options.onRestart ?? (() => this.restart()),
      onBackup: options.onBackup,
      onLog: (entry) => this.dbLogger.log(entry.level, entry.message, entry.meta),
      onTokenUsage: options.onTokenUsage,
      onGenerationTrack: options.onGenerationTrack,
      timerCallbacks: options.timerCallbacks,
      mcpCallbacks: options.mcpCallbacks,
      aiReply: options.aiReply,
      conversation: options.conversation,
      summary: options.summary,
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

    // Use @grammyjs/runner for concurrent update processing. Default bot.start()
    // is sequential, which means a stuck AI reply would block /stop and every
    // other command for up to aiReplyMs (5 min).
    try {
      const handle = run(this.bot);
      this.runnerHandle = handle;
      await this.dbLogger.info("Bot started");

      handle.task()?.catch((err) => {
        this._status = "stopped";
        this.startedAt = null;
        this.bot = null;
        this.runnerHandle = null;
        this.dbLogger
          .error(`Bot crashed: ${err instanceof Error ? err.message : String(err)}`)
          .catch(() => {});
      });
    } catch (err) {
      this._status = "stopped";
      this.startedAt = null;
      this.bot = null;
      this.runnerHandle = null;
      await this.dbLogger.error(
        `Bot failed to start: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  async stop() {
    if (!this.bot || this._status === "stopped") {
      await this.dbLogger.warn("Bot is not running");
      return;
    }

    this._status = "stopped";
    this.startedAt = null;
    if (this.runnerHandle) {
      await this.runnerHandle.stop();
      this.runnerHandle = null;
    }
    this.bot = null;
    await this.dbLogger.info("Bot stopped");
  }

  async restart() {
    this._status = "restarting";
    await this.dbLogger.info("Bot restarting...");
    await this.stop();
    await this.start();
  }

  async sendHtml(chatId: number, html: string): Promise<void> {
    if (!this.bot) {
      throw new Error(`Bot ${this.botId} is not running`);
    }
    await this.bot.api.sendMessage(chatId, html, { parse_mode: "HTML" });
  }

  async sendRichMessage(
    chatId: number,
    format: TelegramRichMessageFormat,
    content: string,
  ): Promise<TelegramRichMessageReceipt> {
    if (!this.bot) {
      throw new Error(`Bot ${this.botId} is not running`);
    }
    const sent = await this.bot.api.sendRichMessage(
      chatId,
      format === "markdown" ? { markdown: content } : { html: content },
    );
    return { messageId: sent.message_id, chatId: sent.chat.id, format };
  }

  async recoverPixaiGeneration(
    record: PixAIGenerationRecord,
    apiKey: string,
    timeoutMs: number,
    createdAtMs: number,
    signal?: AbortSignal,
  ): Promise<void> {
    if (!this.bot) {
      throw new Error(`Bot ${this.botId} is not running`);
    }

    await recoverPixAIGeneration({
      apiKey,
      api: this.bot.api,
      record,
      timeoutMs,
      createdAtMs,
      onLog: this.botConfig.onLog,
      onGenerationTrack: this.botConfig.onGenerationTrack,
      nsfwChecker: this.botConfig.aiReply?.nsfwChecker,
      signal,
    });
  }
}
