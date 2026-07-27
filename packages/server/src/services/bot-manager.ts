import type {
  AiReplyBotConfig,
  AiSelectionCallbacks,
  BotConfig,
  McpCommandConfig,
  SummaryCallbacks,
  TelegramObservationCallbacks,
  TimerCallbacks,
} from "@cos-tool-bot/bot";
import { createBot, disposeBot, recoverPixAIGeneration } from "@cos-tool-bot/bot";
import { run, type FetchOptions, type RunnerHandle } from "@grammyjs/runner";
import type {
  AiGroupOverride,
  BotStatus,
  ConversationCallbacks,
  IBotManager,
  PixAIGenerationRecord,
  TelegramRichMessageFormat,
  TelegramRichMessageReceipt,
  TelegramRichMessageSender,
  TokenUsageRecord,
  UserPrivacyCallbacks,
} from "@cos-tool-bot/shared";
import type { Logger } from "pino";
import type { DbLogger } from "./db-logger.js";
import {
  isTelegramGroupChatId,
  isTelegramUserId,
  mapTelegramMembership,
  type TelegramBotPublicProfile,
} from "./telegram-bot-runtime.js";

export const TELEGRAM_LONG_POLL_UPDATE_TYPES = [
  "message",
  "edited_message",
  "channel_post",
  "edited_channel_post",
  "callback_query",
  "poll_answer",
  "my_chat_member",
  "chat_member",
  "message_reaction",
  "message_reaction_count",
] as const satisfies NonNullable<FetchOptions["allowed_updates"]>;

interface BotManagerOptions {
  botId: string;
  token: string;
  adminChatIds: number[];
  logger: Logger;
  dbLogger: DbLogger;
  aiReply?: AiReplyBotConfig;
  aiSelectionCallbacks?: AiSelectionCallbacks;
  conversation?: ConversationCallbacks;
  privacy?: UserPrivacyCallbacks;
  onRestart?: () => void | Promise<void>;
  onBackup?: () => Promise<{ ok: boolean; filename?: string; error?: string }>;
  onTokenUsage?: (entry: TokenUsageRecord) => void | Promise<void>;
  onGenerationTrack?: (record: PixAIGenerationRecord) => void | Promise<void>;
  timerCallbacks?: TimerCallbacks;
  mcpCallbacks?: McpCommandConfig;
  summary?: SummaryCallbacks;
  telegramObservation?: TelegramObservationCallbacks;
  miniAppUrl?: string;
}

export class BotManager implements IBotManager, TelegramRichMessageSender {
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
      aiSelectionCallbacks: options.aiSelectionCallbacks,
      mcpCallbacks: options.mcpCallbacks,
      aiReply: options.aiReply,
      conversation: options.conversation,
      privacy: options.privacy,
      summary: options.summary,
      telegramObservation: options.telegramObservation,
      miniAppUrl: options.miniAppUrl,
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

    const bot = createBot(this.botConfig);
    this.bot = bot;
    this._status = "running";
    this.startedAt = Date.now();

    // Use @grammyjs/runner for concurrent update processing. Default bot.start()
    // is sequential, which means a stuck AI reply would block /stop and every
    // other command for up to aiReplyMs (5 min).
    try {
      const handle = run(bot, {
        runner: { fetch: { allowed_updates: TELEGRAM_LONG_POLL_UPDATE_TYPES } },
      });
      this.runnerHandle = handle;
      await this.dbLogger.info("Bot started");

      handle.task()?.catch((err) => {
        disposeBot(bot);
        if (this.bot !== bot) return;
        this._status = "stopped";
        this.startedAt = null;
        this.bot = null;
        this.runnerHandle = null;
        this.dbLogger
          .error(`Bot crashed: ${err instanceof Error ? err.message : String(err)}`)
          .catch(() => {});
      });
    } catch (err) {
      disposeBot(bot);
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

    const bot = this.bot;
    const runnerHandle = this.runnerHandle;
    this._status = "stopped";
    this.startedAt = null;
    this.runnerHandle = null;
    if (this.bot === bot) this.bot = null;
    try {
      disposeBot(bot);
    } finally {
      await runnerHandle?.stop();
    }
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

  async getTelegramProfile(): Promise<TelegramBotPublicProfile> {
    const bot = this.requireRunningBot();
    const profile = await bot.api.getMe();
    if (!isTelegramUserId(profile.id)) {
      throw new Error("Telegram returned an invalid bot user ID");
    }
    return {
      telegramUserId: profile.id,
      username: profile.username,
      displayName: [profile.first_name, profile.last_name].filter(Boolean).join(" "),
      observedAt: new Date(),
    };
  }

  async isTelegramMember(input: { chatId: number; userId: number }): Promise<boolean> {
    if (!isTelegramGroupChatId(input.chatId)) {
      throw new Error("Telegram group chat ID must be a negative safe integer");
    }
    if (!isTelegramUserId(input.userId)) {
      throw new Error("Telegram user ID must be a positive safe integer");
    }
    const member = await this.requireRunningBot().api.getChatMember(input.chatId, input.userId);
    return mapTelegramMembership(member);
  }

  async getTelegramBotMembership(input: {
    chatId: number;
  }): Promise<"creator" | "administrator" | "member" | "restricted" | "left" | "kicked"> {
    if (!isTelegramGroupChatId(input.chatId)) {
      throw new Error("Telegram group chat ID must be a negative safe integer");
    }
    const bot = this.requireRunningBot();
    const profile = await bot.api.getMe();
    if (!isTelegramUserId(profile.id)) {
      throw new Error("Telegram returned an invalid bot user ID");
    }
    const member = await bot.api.getChatMember(input.chatId, profile.id);
    return member.status;
  }

  applyTelegramGroupOverride(input: { chatId: number; override: AiGroupOverride }): void {
    if (!isTelegramGroupChatId(input.chatId) || input.override.chatId !== input.chatId) {
      throw new Error("Telegram group override scope is invalid");
    }
    if (this._status !== "running" || !this.bot || !this.botConfig.aiReply) {
      throw new Error(`Bot ${this.botId} is not running with AI configured`);
    }
    this.botConfig.aiReply.groupOverrides[String(input.chatId)] = structuredClone(input.override);
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

  private requireRunningBot(): NonNullable<typeof this.bot> {
    if (this._status !== "running" || !this.bot) {
      throw new Error(`Bot ${this.botId} is not running`);
    }
    return this.bot;
  }
}
