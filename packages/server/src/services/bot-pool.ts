import type { QuoteDependencies } from "@cos-tool-bot/bot";
import { QuoteSourceStore } from "./quote-source-store.js";
import { readScheduledTaskHistory } from "./scheduled-task-history.js";
import { executeScheduledTaskWithBotConfig } from "@cos-tool-bot/bot";
import type {
  ScheduledTaskPlan,
  ScheduledTaskPort,
  ScheduledTaskRecord,
} from "@cos-tool-bot/shared";
import type { ScheduledTaskExecutorOptions } from "./scheduled-tasks.js";
import { assembleAiReply } from "./bot-runtime/ai-reply.js";
import { redactDiagnostic } from "./run-redaction.js";
import { ImageDeliveryError } from "@cos-tool-bot/shared";
import type { MediaTranscriptionPort, PluginRuntimePort } from "@cos-tool-bot/shared";
import type { BotTimerHandlers, TelegramObservationCallbacks } from "@cos-tool-bot/bot";
import { escapeHtml } from "@cos-tool-bot/bot/utils/format";
import type { Database } from "@cos-tool-bot/database";
import {
  bots,
  miniAppChatGrants,
  miniAppOperatorGrants,
  pixaiGenerations,
} from "@cos-tool-bot/database";
import type {
  IBotManager,
  ImageGenerationPort,
  ImageGenerationRequestSnapshot,
  MediaJobView,
  PixAIConfig,
  PixAIGenerationRecord,
  TelegramRichMessageFormat,
  TelegramRichMessageReceipt,
  TelegramRichMessageSender,
  UsageGovernancePort,
} from "@cos-tool-bot/shared";
import { DEFAULT_CONVERSATION_CONFIG, DEFAULT_TIMEOUT_CONFIG } from "@cos-tool-bot/shared";
import { and, asc, eq, lte } from "drizzle-orm";
import type { Logger } from "pino";
import { env } from "../env.js";
import { tryDecrypt } from "../utils/crypto.js";
import { toAiConfigRuntime } from "./ai-config-runtime.js";
import type { BackupService } from "./backup.js";
import { BotManager } from "./bot-manager.js";
import { BotMemoryStore } from "./bot-memory-store.js";
import { BotMemoryWriter, type BotMemoryChanges, type NewBotMemory } from "./bot-memory-writer.js";
import {
  assembleBotRuntime,
  type BotRuntimeHost,
  type BotRuntimeServices,
  type ChatAiSelectionPort,
} from "./bot-runtime/index.js";
import { ConversationStore } from "./conversation-store.js";
import { DbLogger } from "./db-logger.js";
import type { EmbeddingService } from "./embedding-service.js";
import {
  AsyncTaskLimiter,
  isTerminalGenerationRecoveryError,
  PendingGenerationInsertFallbackTracker,
  tryPersistTerminalGenerationFailure,
} from "./generation-recovery.js";
import { ConversationRetention } from "./conversation-retention.js";
import { KeyedAsyncLock } from "./keyed-async-lock.js";
import { PeopleProfileStore } from "./people-profile-store.js";
import { PeopleProfileAvatarService } from "./people-profile-avatar-service.js";
import type { TelegramBotPublicProfile } from "./telegram-bot-runtime.js";
import type { McpClientManager } from "./mcp-client-manager.js";
import type { RssFeedService } from "./rss-feed-service.js";
import type { TimerRegistry } from "./timer-registry.js";
import type { ChatSummaryService } from "./chat-summary-service.js";
import type { SummaryConfigService } from "./summary-config-service.js";
import type { GitWorkspaceService } from "./git-workspace-service.js";
import type { GitHubAppCredentialService } from "./github-app-credentials.js";
import type { HarnessService } from "../harness/service.js";
import {
  GitHubIssueProposalService,
  createGitHubIssueProposalAuthorizer,
} from "./github-issue-proposals.js";
import { SettingsGitHubIssueProposalStore } from "./github-issue-proposal-store.js";
import { GitHubCredentialGenerationGate } from "./github-credential-policy.js";
import {
  BotNotRunningError,
  TelegramRichMessagesUnsupportedError,
} from "./telegram-rich-message-errors.js";
import { UserPrivacyService } from "./user-privacy-service.js";
import { GenerationLibraryService } from "./generation-library-service.js";
import type { EngagementSampleService } from "./engagement-sample-service.js";
import type { ChatAiSelectionRuntimeRegistry } from "./chat-ai-selection-runtime-registry.js";

const GENERATION_RECOVERY_CONCURRENCY = 3;
const GENERATION_RECOVERY_BATCH_SIZE = GENERATION_RECOVERY_CONCURRENCY;
const GENERATION_RECOVERY_SWEEP_INTERVAL_MS = 60_000;

interface BotPoolServices extends BotRuntimeServices {
  telegramProfileObserver?: (
    botId: string,
    profile: TelegramBotPublicProfile,
  ) => void | Promise<void>;
}

interface GenerationRecoveryEntry {
  controller: AbortController;
  promise: Promise<void>;
}

interface GenerationRecoveryConfig {
  manager: BotManager;
  apiKey: string;
  timeoutMs: number;
  preexistingPendingCutoff: Date;
}

function supportsTelegramRichMessages(
  manager: IBotManager,
): manager is IBotManager & TelegramRichMessageSender {
  return "sendRichMessage" in manager && typeof manager.sendRichMessage === "function";
}

export class BotPool {
  private managers = new Map<string, IBotManager>();
  // Serializes start/stop/restart per botId to avoid concurrent double-start races.
  private lifecycleLocks = new KeyedAsyncLock();
  private aiConfigLocks = new KeyedAsyncLock();
  private botTimerHandlers = new Map<string, BotTimerHandlers>();
  private readonly conversationRetention: ConversationRetention;
  private generationRecoveries = new Map<string, GenerationRecoveryEntry>();
  private generationRecoveryLimiter = new AsyncTaskLimiter(GENERATION_RECOVERY_CONCURRENCY);
  private generationRecoveryConfigs = new Map<string, GenerationRecoveryConfig>();
  private generationRecoveryEpochs = new Map<string, number>();
  private generationRecoverySweep?: Promise<void>;
  private generationRecoveryTimer?: ReturnType<typeof setInterval>;
  private readonly generationInsertFallbacks = new PendingGenerationInsertFallbackTracker();
  private readonly conversationStore: ConversationStore;
  private readonly profileStore: PeopleProfileStore;
  private readonly profileAvatarService: PeopleProfileAvatarService;
  private readonly botMemoryStore: BotMemoryStore;
  private botMemoryWriter: BotMemoryWriter;
  private memoryEmbeddingServices = new Map<string, EmbeddingService>();
  private readonly userPrivacyService: UserPrivacyService;
  private readonly generationLibraryService: GenerationLibraryService;
  private aiSelectionRuntimeDisposers = new Map<string, () => void>();
  private readonly timerRegistry: TimerRegistry;
  private readonly githubCredentialGenerations = new GitHubCredentialGenerationGate();
  private readonly services: BotPoolServices;
  private readonly deferredRestarts = new Map<
    string,
    { generation: number; timer?: ReturnType<typeof setTimeout> }
  >();
  private readonly deferredRestartTasks = new Map<string, Promise<void>>();
  private readonly runtimeHost: BotRuntimeHost = {
    getRuntimeStatus: (botId) => {
      const manager = this.managers.get(botId);
      return manager ? { status: manager.status, uptime: manager.uptime } : undefined;
    },
    restartBot: (botId) => this.restartBot(botId),
    createDeferredRestart: (botId) => this.createDeferredRestart(botId),
    withAiConfigLock: (botId, operation) => this.withAiConfigLock(botId, operation),
    isDelegatedGroupAdmin: (botId, chatId, userId) =>
      this.isDelegatedGroupAdmin(botId, chatId, userId),
    triggerConversationCleanup: (botId, retentionDays) =>
      this.triggerConversationCleanup(botId, retentionDays),
    fireRecoveredTimer: (timerId, botId, chatId, meta, delayed) =>
      this.fireRecoveredTimer(timerId, botId, chatId, meta, delayed),
    getActiveTimersForBot: (botId) => this.getActiveTimersForBot(botId),
    cancelTimerForBot: (botId, timerId) => this.cancelTimerForBot(botId, timerId),
    attachTimerHandlers: (botId, handlers) => {
      this.botTimerHandlers.set(botId, handlers);
    },
    replaceAiSelectionRuntime: (botId, register) => {
      this.aiSelectionRuntimeDisposers.get(botId)?.();
      this.aiSelectionRuntimeDisposers.set(botId, register());
    },
  };

  constructor(
    private db: Database,
    private logger: Logger,
    timerRegistry: TimerRegistry,
  ) {
    this.timerRegistry = timerRegistry;
    this.conversationStore = new ConversationStore(db);
    this.conversationRetention = new ConversationRetention({
      cleanup: (botId, days) => this.conversationStore.cleanup(botId, days),
      listActiveBots: async () => {
        const rows = await db
          .select({ id: bots.id, aiConfig: bots.aiConfig })
          .from(bots)
          .where(and(eq(bots.isActive, true), eq(bots.platform, "telegram")));
        return rows.map((bot) => ({
          id: bot.id,
          retentionDays:
            bot.aiConfig?.conversationConfig?.retentionDays ??
            DEFAULT_CONVERSATION_CONFIG.retentionDays,
        }));
      },
      warn: (error, message) => logger.warn(error, message),
    });
    this.profileStore = new PeopleProfileStore(db);
    this.userPrivacyService = new UserPrivacyService(db);
    this.profileAvatarService = new PeopleProfileAvatarService(
      this.profileStore,
      this.userPrivacyService,
    );
    this.botMemoryStore = new BotMemoryStore(db);
    this.botMemoryWriter = new BotMemoryWriter(
      this.botMemoryStore,
      (botId) => this.memoryEmbeddingServices.get(botId),
      logger,
    );
    this.generationLibraryService = new GenerationLibraryService(db, this.userPrivacyService);
    this.services = {
      db,
      logger,
      timerRegistry,
      conversationStore: this.conversationStore,
      profileStore: this.profileStore,
      profileAvatarService: this.profileAvatarService,
      botMemoryStore: this.botMemoryStore,
      userPrivacyService: this.userPrivacyService,
      generationLibraryService: this.generationLibraryService,
      githubCredentialGenerations: this.githubCredentialGenerations,
      generationInsertFallbacks: this.generationInsertFallbacks,
    };
    this.services.githubIssueProposalService = new GitHubIssueProposalService(
      new SettingsGitHubIssueProposalStore(db),
      createGitHubIssueProposalAuthorizer(
        db,
        env.ENCRYPTION_KEY,
        () => this.services.githubAppCredentialService,
      ),
    );
  }

  setChatAiSelectionService(
    service: ChatAiSelectionPort,
    runtimeRegistry: ChatAiSelectionRuntimeRegistry,
  ): void {
    this.services.chatAiSelectionService = service;
    this.services.chatAiSelectionRuntimeRegistry = runtimeRegistry;
  }

  async notifyScheduledTaskFailure(task: ScheduledTaskRecord, error: string): Promise<void> {
    const manager = this.managers.get(task.botId);
    if (!(manager instanceof BotManager) || manager.status !== "running")
      throw new Error("Task notification Bot is unavailable");
    const [bot] = await this.db.select().from(bots).where(eq(bots.id, task.botId)).limit(1);
    if (!bot) throw new Error("Task notification Bot is unavailable");
    const text = `定时任务 ${task.id} 连续失败后已暂停。请查看执行记录后恢复。\n${String(redactDiagnostic(error)).slice(0, 1500)}`;
    const recipients = bot.adminChatIds.length ? bot.adminChatIds : [task.chatId];
    await Promise.all(
      recipients.map((chatId) =>
        manager.sendHtml(
          chatId,
          escapeHtml(text),
          chatId === task.chatId ? (task.threadId ?? undefined) : undefined,
        ),
      ),
    );
  }

  setQuoteRenderer(renderer: QuoteDependencies["renderer"]) {
    this.services.quoteRenderer = renderer;
    this.services.quoteSourceStore = new QuoteSourceStore(this.db);
  }

  setScheduledTasks(port: ScheduledTaskPort) {
    this.services.scheduledTasks = port;
  }

  async runScheduledTask(
    task: ScheduledTaskRecord,
    plan: ScheduledTaskPlan,
    context: ScheduledTaskExecutorOptions,
  ): ReturnType<typeof executeScheduledTaskWithBotConfig> {
    const manager = this.managers.get(task.botId);
    if (!(manager instanceof BotManager) || manager.status !== "running")
      throw new Error("Task Bot is not running");
    const [bot] = await this.db.select().from(bots).where(eq(bots.id, task.botId)).limit(1);
    if (!bot || task.approvedByUserId === null)
      throw new Error("Task Bot or approved administrator is unavailable");
    const token = tryDecrypt(bot.encryptedToken, env.ENCRYPTION_KEY);
    if (!token) throw new Error("Task Bot credentials are unavailable");
    const runtime = toAiConfigRuntime(bot.aiConfig, env.ENCRYPTION_KEY);
    if (!runtime) throw new Error("Task AI configuration is unavailable");
    const secrets = [token, ...runtime.providers.map((provider) => provider.apiKey)];
    try {
      const assembled = await assembleAiReply(
        bot.id,
        runtime,
        new DbLogger(this.db, this.logger, bot.id),
        this.services,
        this.runtimeHost,
      );
      if (!assembled) throw new Error("Task Agent AI configuration is unavailable or disabled");
      const now = new Date();
      const historyWindow = {
        since: new Date(now.getTime() - (plan.dataScope.lookbackHours ?? 24) * 3600_000),
        until: now,
        limit: Math.min(plan.dataScope.maxMessages ?? 500, 1000),
      };
      return await executeScheduledTaskWithBotConfig({
        api: token,
        plan,
        chatId: task.chatId,
        threadId: task.threadId ?? undefined,
        userId: task.approvedByUserId,
        signal: context.signal,
        onAgentResolved: context.onAgentResolved,
        aiConfig: assembled.aiReply,
        taskAgentConfig: runtime.config.taskAgentConfig,
        agentToolsConfig: runtime.config.agentToolsConfig,
        adminIds: bot.adminChatIds,
        now,
        readTaskHistory: async () => {
          if (plan.dataScope.kind !== "chat") throw new Error("Task has no approved history scope");
          return readScheduledTaskHistory(this.db, task, historyWindow);
        },
        summarizeTaskHistory: this.services.summaryService
          ? async (signal) => {
              if (plan.dataScope.kind !== "chat")
                throw new Error("Task has no approved history scope");
              return this.services.summaryService!.summarize({
                botId: task.botId,
                chatId: task.chatId,
                threadId: task.threadId,
                userId: task.approvedByUserId!,
                approvedWindow: historyWindow,
                signal,
                request: { instructions: plan.instructions },
              });
            }
          : undefined,
      });
    } catch (error) {
      throw new Error(
        String(redactDiagnostic(error instanceof Error ? error.message : String(error), secrets)),
      );
    }
  }

  setBackupService(service: BackupService) {
    this.services.backupService = service;
  }

  getGenerationLibraryService(): GenerationLibraryService {
    return this.generationLibraryService;
  }

  setPlugins(plugins: PluginRuntimePort) {
    this.services.plugins = plugins;
  }

  setMediaTranscriptionPort(port: MediaTranscriptionPort) {
    this.services.mediaTranscriptionPort = port;
  }

  setMcpClientManager(manager: McpClientManager) {
    this.services.mcpClientManager = manager;
  }

  setImageGenerationPort(port: ImageGenerationPort) {
    this.services.imageGenerationPort = port;
  }

  setNsfwChecker(checker: NonNullable<BotRuntimeServices["nsfwChecker"]>) {
    this.services.nsfwChecker = checker;
  }

  setUsageGovernance(port: UsageGovernancePort) {
    this.services.usageGovernance = port;
  }

  setRssFeedService(service: RssFeedService) {
    this.services.rssFeedService = service;
    service.setDigestTrigger((botId, chatId, eventDescription) =>
      this.fireRssDigest(botId, chatId, eventDescription),
    );
  }

  setSummaryService(svc: ChatSummaryService) {
    this.services.summaryService = svc;
  }

  setSummaryConfigService(svc: SummaryConfigService) {
    this.services.summaryConfigService = svc;
  }

  setGitWorkspaceService(service: GitWorkspaceService) {
    this.services.gitWorkspaceService = service;
  }

  setGitHubAppCredentialService(service: GitHubAppCredentialService) {
    this.services.githubAppCredentialService = service;
  }

  setHarnessService(service: HarnessService) {
    this.services.harnessService = service;
  }

  setEngagementSampleService(service: Pick<EngagementSampleService, "persist">) {
    this.services.engagementSampleService = service;
  }

  setTelegramDirectoryCallbacks(
    observation: TelegramObservationCallbacks,
    profileObserver: (botId: string, profile: TelegramBotPublicProfile) => void | Promise<void>,
  ) {
    this.services.telegramObservation = observation;
    this.services.telegramProfileObserver = profileObserver;
  }

  invalidateGitHubCredentials(botId: string): void {
    this.githubCredentialGenerations.invalidate(botId);
  }

  getSummaryService() {
    return this.services.summaryService;
  }

  getSummaryConfigService() {
    return this.services.summaryConfigService;
  }

  async sendHtml(
    botId: string,
    chatId: number,
    html: string,
    threadId?: number,
    signal?: AbortSignal,
  ): Promise<void> {
    const manager = this.managers.get(botId);
    if (!manager) {
      this.logger.warn({ botId, chatId }, "sendHtml: no manager for bot");
      return;
    }
    if ((threadId !== undefined || signal !== undefined) && manager instanceof BotManager)
      await manager.sendHtml(chatId, html, threadId, signal);
    else await manager.sendHtml(chatId, html);
  }

  async sendImageFiles(
    botId: string,
    chatId: number,
    files: string[],
    input: {
      prompt: string;
      detailUrl: string;
      presetKey?: string;
      requestSnapshot?: ImageGenerationRequestSnapshot;
      threadId?: number;
    },
  ): Promise<number[]> {
    const manager = this.managers.get(botId);
    if (!manager) throw new ImageDeliveryError("not_sent", "BOT_NOT_RUNNING", 15);
    if (!(manager instanceof BotManager))
      throw new ImageDeliveryError("not_sent", "IMAGES_UNSUPPORTED");
    return manager.sendImageFiles(chatId, files, input);
  }

  async sendVideoFile(
    botId: string,
    chatId: number,
    path: string,
    input: {
      title: string;
      durationSeconds: number;
      threadId?: number;
      signal: AbortSignal;
    },
  ): Promise<number> {
    const manager = this.managers.get(botId);
    if (!(manager instanceof BotManager)) throw new Error("video_delivery_unavailable");
    return manager.sendVideoFile(chatId, path, input);
  }

  async sendMediaConfirmation(
    botId: string,
    chatId: number,
    job: MediaJobView,
    threadId?: number,
  ): Promise<void> {
    const manager = this.managers.get(botId);
    if (!(manager instanceof BotManager)) throw new Error("media_confirmation_unavailable");
    await manager.sendMediaConfirmation(chatId, job, threadId);
  }

  async isMediaAdmin(botId: string, userId: number): Promise<boolean> {
    if (!Number.isSafeInteger(userId) || userId < 1) return false;
    const [bot] = await this.db
      .select({ adminIds: bots.adminChatIds })
      .from(bots)
      .where(eq(bots.id, botId))
      .limit(1);
    return bot?.adminIds?.includes(userId) === true;
  }

  private async isDelegatedGroupAdmin(
    botId: string,
    chatId: number,
    userId: number,
  ): Promise<boolean> {
    const [grant] = await this.db
      .select({ userId: miniAppOperatorGrants.telegramUserId })
      .from(miniAppOperatorGrants)
      .innerJoin(
        miniAppChatGrants,
        and(
          eq(miniAppChatGrants.botId, miniAppOperatorGrants.botId),
          eq(miniAppChatGrants.chatId, chatId),
        ),
      )
      .where(
        and(
          eq(miniAppOperatorGrants.botId, botId),
          eq(miniAppOperatorGrants.telegramUserId, userId),
        ),
      )
      .limit(1);
    if (!grant) return false;
    const manager = this.managers.get(botId);
    if (!(manager instanceof BotManager) || manager.status !== "running") return false;
    try {
      const role = await manager.getTelegramMemberRole(chatId, userId);
      return role === "creator" || role === "administrator";
    } catch {
      return false;
    }
  }

  async sendRichMessage(
    botId: string,
    chatId: number,
    format: TelegramRichMessageFormat,
    content: string,
  ): Promise<TelegramRichMessageReceipt> {
    const manager = this.managers.get(botId);
    if (!manager) {
      throw new BotNotRunningError(botId);
    }
    if (!supportsTelegramRichMessages(manager)) {
      throw new TelegramRichMessagesUnsupportedError(botId);
    }
    return manager.sendRichMessage(chatId, format, content);
  }

  getConversationStore(): ConversationStore {
    return this.conversationStore;
  }

  getProfileStore(): PeopleProfileStore {
    return this.profileStore;
  }

  getBotMemoryStore(): BotMemoryStore {
    return this.botMemoryStore;
  }

  /** Memory writes that embed with the running Bot's embedder; stopped Bots store text only. */
  getBotMemoryWriter(): BotMemoryWriter {
    return this.botMemoryWriter;
  }

  createBotMemoryForAdmin(botId: string, memory: NewBotMemory) {
    return this.botMemoryWriter.create(botId, memory, {
      embeddingTimeoutMs: DEFAULT_TIMEOUT_CONFIG.perStepMs,
    });
  }

  updateBotMemoryForAdmin(botId: string, memoryId: number, changes: BotMemoryChanges) {
    return this.botMemoryWriter.update(botId, memoryId, changes, {
      embeddingTimeoutMs: DEFAULT_TIMEOUT_CONFIG.perStepMs,
    });
  }

  private triggerConversationCleanup(botId: string, retentionDays: number) {
    void this.conversationRetention.trigger(botId, retentionDays);
  }

  private runGenerationRecoverySweep(): Promise<void> {
    if (this.generationRecoverySweep) return this.generationRecoverySweep;

    const sweep = Promise.all(
      [...this.generationRecoveryConfigs.entries()].map(([botId, config]) =>
        this.schedulePendingGenerationRecovery(
          botId,
          config.manager,
          config.apiKey,
          config.timeoutMs,
          new Date(
            Math.max(
              config.preexistingPendingCutoff.getTime(),
              Date.now() - config.timeoutMs - 60_000,
            ),
          ),
        ).catch((err) => {
          this.logger.error({ err, botId }, "Failed to schedule periodic generation recovery");
        }),
      ),
    )
      .then(() => undefined)
      .finally(() => {
        if (this.generationRecoverySweep === sweep) {
          this.generationRecoverySweep = undefined;
        }
      });
    this.generationRecoverySweep = sweep;
    return sweep;
  }

  private startGenerationRecoveryScheduler() {
    if (this.generationRecoveryTimer) return;

    this.generationRecoveryTimer = setInterval(() => {
      void this.runGenerationRecoverySweep();
    }, GENERATION_RECOVERY_SWEEP_INTERVAL_MS);
    this.generationRecoveryTimer.unref();
  }

  private stopGenerationRecoverySchedulerIfIdle() {
    if (this.generationRecoveryConfigs.size > 0 || !this.generationRecoveryTimer) return;
    clearInterval(this.generationRecoveryTimer);
    this.generationRecoveryTimer = undefined;
  }

  async startAll() {
    let activeBots;
    try {
      activeBots = await this.db
        .select()
        .from(bots)
        .where(and(eq(bots.isActive, true), eq(bots.platform, "telegram")));
    } catch (err) {
      this.logger.warn(err, "Failed to query active bots (table may not exist — run migrations)");
      return;
    }

    this.conversationRetention.start(
      activeBots.map((bot) => ({
        id: bot.id,
        retentionDays:
          bot.aiConfig?.conversationConfig?.retentionDays ??
          DEFAULT_CONVERSATION_CONFIG.retentionDays,
      })),
    );

    if (activeBots.length === 0) return;
    this.logger.info(`Starting ${activeBots.length} active bot(s)...`);
    for (const bot of activeBots) {
      try {
        await this.startBot(bot.id);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        this.logger.error(err, `Failed to start bot "${bot.name}" (${bot.id}): ${msg}`);
      }
    }
  }

  async stopAll() {
    for (const botId of this.deferredRestarts.keys()) this.cancelDeferredRestart(botId);
    const retentionStopped = this.conversationRetention.stop();
    this.generationRecoveryConfigs.clear();
    this.stopGenerationRecoverySchedulerIfIdle();
    await retentionStopped;

    const ids = [...new Set([...this.managers.keys(), ...this.deferredRestartTasks.keys()])];
    for (const id of ids) {
      try {
        await this.stopBot(id);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        this.logger.error(err, `Failed to stop bot ${id}: ${msg}`);
      }
    }
    if (this.generationRecoverySweep) {
      await Promise.allSettled([this.generationRecoverySweep]);
    }
  }

  withAiConfigLock<T>(botId: string, operation: () => Promise<T>): Promise<T> {
    return this.aiConfigLocks.run(botId, operation);
  }

  async startBot(botId: string) {
    return this.lifecycleLocks.run(botId, () => this.startBotImpl(botId));
  }

  private async startBotImpl(botId: string) {
    const [bot] = await this.db.select().from(bots).where(eq(bots.id, botId));
    if (!bot) throw new Error(`Bot ${botId} not found`);
    if (bot.platform && bot.platform !== "telegram") throw new Error("Unsupported bot platform");
    if (!bot.isActive) throw new Error(`Bot ${botId} is disabled`);

    const existing = this.managers.get(botId);
    if (existing) {
      if (existing.status === "running") {
        this.logger.warn(`Bot ${botId} is already running, skipping`);
        return;
      }
      // Stale manager left behind by a crash/failed start — clean it up before restarting.
      this.logger.warn(
        `Bot ${botId} has a stale manager (status=${existing.status}); cleaning up before start`,
      );
      await this.stopBotImpl(botId);
    }

    const token = tryDecrypt(bot.encryptedToken, env.ENCRYPTION_KEY);
    if (!token) {
      throw new Error(
        "Encryption key mismatch: cannot decrypt bot token. Please update the token in bot settings.",
      );
    }
    const recoveredPendingTurns = await this.conversationStore.recoverPendingTurns(botId);
    if (recoveredPendingTurns > 0) {
      this.logger.warn(
        { botId, recoveredPendingTurns },
        "Recovered incomplete conversation turns before bot startup",
      );
    }
    const dbLogger = new DbLogger(this.db, this.logger, botId);
    let miniAppUrl: string | undefined;
    if (bot.miniAppEnabled) {
      const configuredBaseUrl = new URL(env.BETTER_AUTH_URL);
      if (configuredBaseUrl.protocol !== "https:") {
        throw new Error("Telegram Mini App requires an HTTPS BETTER_AUTH_URL");
      }
      miniAppUrl = new URL(`/mini-app/${botId}/help`, configuredBaseUrl).toString();
    }
    this.deferredRestarts.set(botId, { generation: 0 });
    const runtime = await assembleBotRuntime(
      {
        bot,
        token,
        aiRuntime: toAiConfigRuntime(bot.aiConfig, env.ENCRYPTION_KEY),
        dbLogger,
        miniAppUrl,
      },
      this.services,
      this.runtimeHost,
    ).catch((error: unknown) => {
      this.cancelDeferredRestart(botId);
      this.deferredRestarts.delete(botId);
      throw error;
    });
    const manager = new BotManager(runtime.config, runtime.managerOptions);

    this.managers.set(botId, manager);
    try {
      await manager.start();
    } catch (error) {
      // BotManager retains its runtime when shutdown/drain fails. Confirm a retryable stop before
      // dropping the only Pool-owned reference; otherwise a later start could create a replacement
      // while detached work from this manager is still alive.
      await this.stopBotImpl(botId);
      throw error;
    }
    if (manager.status !== "running") {
      await this.stopBotImpl(botId);
      throw new Error("Bot failed to start; check bot logs for details");
    }
    if (runtime.embeddingService) {
      this.memoryEmbeddingServices.set(botId, runtime.embeddingService);
    }
    if (this.services.chatAiSelectionService && runtime.config.aiReply) {
      try {
        const published = await this.services.chatAiSelectionService.retryPublish(botId);
        if (!published.applied) {
          this.logger.warn({ botId }, "AI selection snapshot is pending runtime application");
        }
      } catch (error) {
        this.logger.warn(
          { botId, error },
          "Bot started but its AI selection snapshot remains pending",
        );
      }
    }
    if (this.botTimerHandlers.has(botId)) {
      try {
        await this.timerRegistry.resumeBot(botId, (timerId, ownerBotId, chatId, meta, delayed) =>
          this.fireRecoveredTimer(timerId, ownerBotId, chatId, meta, delayed),
        );
      } catch (error) {
        await this.stopBotImpl(botId);
        throw error;
      }
    }
    if (this.services.telegramProfileObserver) {
      try {
        const profile = await manager.getTelegramProfile();
        await this.services.telegramProfileObserver(botId, profile);
      } catch (err) {
        this.logger.warn({ err, botId }, "Failed to observe Telegram bot profile");
      }
    }
    void runtime.runInitialHistoryGovernance?.().catch((err) => {
      void dbLogger.error(
        `Initial conversation history governance failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    });
  }

  async stopBot(botId: string) {
    this.cancelDeferredRestart(botId);
    return this.lifecycleLocks.run(botId, () => this.stopBotImpl(botId));
  }

  private async stopBotImpl(botId: string) {
    this.cancelDeferredRestart(botId);
    this.generationRecoveryConfigs.delete(botId);
    this.stopGenerationRecoverySchedulerIfIdle();
    await this.cancelGenerationRecoveries(botId, `Bot ${botId} stopped`);
    await this.timerRegistry.pauseBot(botId);
    const manager = this.managers.get(botId);
    let stopped = !manager;
    try {
      if (manager) {
        await manager.stop();
        stopped = true;
      }
    } finally {
      if (stopped) {
        this.cancelDeferredRestart(botId);
        this.deferredRestarts.delete(botId);
        this.managers.delete(botId);
        this.memoryEmbeddingServices.delete(botId);
        this.botTimerHandlers.delete(botId);
        this.aiSelectionRuntimeDisposers.get(botId)?.();
        this.aiSelectionRuntimeDisposers.delete(botId);
      }
    }
  }

  async restartBot(botId: string) {
    this.cancelDeferredRestart(botId);
    return this.lifecycleLocks.run(botId, () => this.restartBotImpl(botId));
  }

  private async restartBotImpl(botId: string, isCurrent?: () => boolean) {
    const [bot] = await this.db
      .select({ isActive: bots.isActive })
      .from(bots)
      .where(eq(bots.id, botId));
    // Stop can invalidate a deferred request while this database read is awaiting.
    if (isCurrent && !isCurrent()) return;
    if (!bot) throw new Error(`Bot ${botId} not found`);
    if (!bot.isActive) {
      await this.stopBotImpl(botId);
      throw new Error(`Bot ${botId} is disabled`);
    }
    await this.stopBotImpl(botId);
    await this.startBotImpl(botId);
  }

  private cancelDeferredRestart(botId: string): void {
    const scope = this.deferredRestarts.get(botId);
    if (scope?.timer) clearTimeout(scope.timer);
    if (scope) {
      scope.timer = undefined;
      scope.generation++;
    }
  }

  private createDeferredRestart(botId: string): () => void {
    const scope = this.deferredRestarts.get(botId);
    return () => {
      if (!scope || this.deferredRestarts.get(botId) !== scope) return;
      const manager = this.managers.get(botId);
      if (manager?.status !== "running") return;
      if (scope.timer) clearTimeout(scope.timer);
      const generation = ++scope.generation;
      scope.timer = setTimeout(() => {
        scope.timer = undefined;
        const isCurrent = () =>
          this.deferredRestarts.get(botId) === scope &&
          scope.generation === generation &&
          this.managers.get(botId) === manager;
        const task = this.lifecycleLocks
          .run(botId, async () => {
            if (isCurrent()) await this.restartBotImpl(botId, isCurrent);
          })
          .catch((err) => {
            this.logger.warn({ err, botId }, "Deferred MCP restart failed");
          })
          .finally(() => {
            if (this.deferredRestartTasks.get(botId) === task)
              this.deferredRestartTasks.delete(botId);
          });
        this.deferredRestartTasks.set(botId, task);
      }, 2000);
      scope.timer.unref();
    };
  }

  getManager(botId: string): IBotManager | undefined {
    return this.managers.get(botId);
  }

  getAllManagers(): Map<string, IBotManager> {
    return this.managers;
  }

  suppressGenerationFallback(botId: string, taskId: string): void {
    this.generationInsertFallbacks.suppress(botId, taskId);
  }

  clearDeletedBotGenerationState(botId: string): void {
    this.generationInsertFallbacks.clearBot(botId);
    this.generationRecoveryEpochs.delete(botId);
  }

  private async schedulePendingGenerationRecovery(
    botId: string,
    manager: BotManager,
    apiKey: string,
    timeoutMs: number,
    pendingCutoff: Date,
  ): Promise<number> {
    const epoch = this.generationRecoveryEpochs.get(botId) ?? 0;
    if (!this.isCurrentGenerationRecovery(botId, manager, epoch)) return 0;

    if (this.countGenerationRecoveries(botId) >= GENERATION_RECOVERY_BATCH_SIZE) return 0;

    const pendingCondition = and(
      eq(pixaiGenerations.botId, botId),
      eq(pixaiGenerations.status, "pending"),
      lte(pixaiGenerations.createdAt, pendingCutoff),
    );
    const pending = await this.db
      .select()
      .from(pixaiGenerations)
      .where(pendingCondition)
      .orderBy(asc(pixaiGenerations.createdAt))
      .limit(GENERATION_RECOVERY_BATCH_SIZE);

    if (!this.isCurrentGenerationRecovery(botId, manager, epoch)) return 0;
    const availableSlots = GENERATION_RECOVERY_BATCH_SIZE - this.countGenerationRecoveries(botId);
    if (availableSlots <= 0) return 0;

    let started = 0;
    for (const row of pending) {
      if (started >= availableSlots) break;
      if (!this.isCurrentGenerationRecovery(botId, manager, epoch)) break;
      const recoveryKey = `${botId}:${row.taskId}`;
      if (this.generationRecoveries.has(recoveryKey)) continue;

      const record: PixAIGenerationRecord = {
        chatId: row.chatId,
        userId: row.userId ?? undefined,
        taskId: row.taskId,
        prompt: row.prompt,
        negativePrompt: row.negativePrompt ?? undefined,
        modelId: row.modelId,
        width: row.width,
        height: row.height,
        batchSize: row.batchSize,
        samplingSteps: row.samplingSteps ?? undefined,
        cfgScale: row.cfgScale ?? undefined,
        promptHelper: row.promptHelper ?? undefined,
        pixaiConfig: (row.pixaiConfig as PixAIConfig | null) ?? undefined,
        status: "pending",
      };

      const controller = new AbortController();
      const entry: GenerationRecoveryEntry = {
        controller,
        promise: Promise.resolve(),
      };
      entry.promise = this.generationRecoveryLimiter
        .run(
          () =>
            manager.recoverPixaiGeneration(
              record,
              apiKey,
              timeoutMs,
              row.createdAt.getTime(),
              controller.signal,
            ),
          controller.signal,
        )
        .then(() => {
          this.logger.info({ botId, taskId: row.taskId }, "Pending generation recovery completed");
        })
        .catch(async (err) => {
          if (controller.signal.aborted) {
            this.logger.info(
              { botId, taskId: row.taskId },
              "Pending generation recovery cancelled",
            );
            return;
          }

          const errorMessage = err instanceof Error ? err.message : String(err);
          const terminal = isTerminalGenerationRecoveryError(err);

          if (!terminal) {
            this.logger.warn(
              { err, botId, taskId: row.taskId },
              "Pending generation recovery paused; record remains pending",
            );
            return;
          }

          const persistence = await tryPersistTerminalGenerationFailure(() =>
            this.db
              .update(pixaiGenerations)
              .set({
                status: "failed",
                errorMessage,
                durationMs: Math.min(Date.now() - row.createdAt.getTime(), 2_147_483_647),
                completedAt: new Date(),
              })
              .where(
                and(
                  eq(pixaiGenerations.botId, botId),
                  eq(pixaiGenerations.taskId, row.taskId),
                  eq(pixaiGenerations.status, "pending"),
                ),
              )
              .returning({ chatId: pixaiGenerations.chatId }),
          );
          if (!persistence.ok) {
            this.logger.error(
              {
                err: persistence.error,
                botId,
                taskId: row.taskId,
                recoveryError: errorMessage,
              },
              "Failed to persist terminal generation recovery failure",
            );
            return;
          }
          const claimed = persistence.value[0];
          if (!claimed) {
            this.logger.info(
              { botId, taskId: row.taskId },
              "Terminal generation recovery was already claimed",
            );
            return;
          }

          try {
            await manager.sendHtml(claimed.chatId, escapeHtml(`图片生成失败: ${errorMessage}`));
          } catch (notifyError) {
            this.logger.warn(
              { err: notifyError, botId, taskId: row.taskId },
              "Failed to notify user about recovered PixAI failure",
            );
          }
          this.logger.warn(
            { botId, taskId: row.taskId, errorMessage },
            "Pending generation recovery reached a terminal failure",
          );
        })
        .finally(() => {
          if (this.generationRecoveries.get(recoveryKey) === entry) {
            this.generationRecoveries.delete(recoveryKey);
          }
        });

      this.generationRecoveries.set(recoveryKey, entry);
      started++;
    }

    if (started > 0) {
      this.logger.info({ botId, count: started }, "Scheduled pending generation recovery");
    }
    return started;
  }

  private countGenerationRecoveries(botId: string): number {
    const prefix = `${botId}:`;
    let count = 0;
    for (const key of this.generationRecoveries.keys()) {
      if (key.startsWith(prefix)) count++;
    }
    return count;
  }

  private isCurrentGenerationRecovery(botId: string, manager: BotManager, epoch: number): boolean {
    return (
      (this.generationRecoveryEpochs.get(botId) ?? 0) === epoch &&
      this.managers.get(botId) === manager &&
      manager.status === "running"
    );
  }

  private async cancelGenerationRecoveries(botId: string, reason: string): Promise<void> {
    this.generationRecoveryEpochs.set(botId, (this.generationRecoveryEpochs.get(botId) ?? 0) + 1);
    const prefix = `${botId}:`;
    const pending: Promise<void>[] = [];
    for (const [key, entry] of this.generationRecoveries) {
      if (!key.startsWith(prefix)) continue;
      entry.controller.abort(new Error(reason));
      pending.push(entry.promise);
    }
    await Promise.allSettled(pending);
  }

  /** Cancel a timer, clearing both the registry and the bot's PendingActionRegistry. */
  async cancelTimer(timerId: string): Promise<boolean> {
    const timer = this.timerRegistry.get(timerId);
    const cancelled = await this.timerRegistry.cancel(timerId);
    if (cancelled && timer?.botId) {
      this.botTimerHandlers.get(timer.botId)?.cancelPendingTimer(timerId);
    }
    return cancelled;
  }

  getActiveTimersForBot(botId: string) {
    return this.timerRegistry.listActive({ botId });
  }

  /** Cancel only when the timer belongs to the requesting Bot. */
  async cancelTimerForBot(botId: string, timerId: string): Promise<boolean> {
    const timer = this.timerRegistry.get(timerId);
    if (!timer || timer.botId !== botId) return false;
    const cancelled = await this.timerRegistry.cancel(timerId);
    if (cancelled) this.botTimerHandlers.get(botId)?.cancelPendingTimer(timerId);
    return cancelled;
  }

  /** Fire RSS digest via bot's continueChat. Returns true if handler existed and was invoked. */
  private async fireRssDigest(
    botId: string,
    chatId: number,
    eventDescription: string,
  ): Promise<boolean> {
    const handlers = this.botTimerHandlers.get(botId);
    if (handlers) {
      try {
        const delivered = await handlers.fireTimer(
          chatId,
          `rss_digest_${Date.now()}`,
          eventDescription,
          chatId > 0 ? chatId : undefined,
          undefined,
          false,
        );
        if (!delivered) {
          this.logger.warn(
            { botId, chatId },
            "RSS digest completed without a visible Telegram delivery",
          );
          return false;
        }
        this.logger.info({ botId, chatId }, "RSS digest triggered via continueChat");
        return true;
      } catch (error) {
        this.logger.error({ botId, chatId, error }, "RSS digest continueChat failed");
        return false;
      }
    }
    this.logger.warn({ botId, chatId }, "No handler for bot, RSS digest cannot trigger");
    return false;
  }

  /** Fire a recovered timer by triggering the bot's continueChat. */
  async fireRecoveredTimer(
    timerId: string,
    botId: string,
    chatId: number,
    meta: Record<string, unknown> | null,
    delayed = false,
  ): Promise<void> {
    const manager = this.managers.get(botId);
    if (!manager) {
      this.logger.warn(`Cannot fire recovered timer ${timerId}: bot ${botId} not managed`);
      return Promise.reject(new Error("Bot runtime is not managed"));
    }

    // Fire via bot's continueChat
    const handlers = this.botTimerHandlers.get(botId);
    if (handlers) {
      const reason = (meta?.reason as string) ?? "Recovered timer";
      const storedUserId = typeof meta?.["userId"] === "number" ? meta["userId"] : undefined;
      const userId = storedUserId ?? (chatId > 0 ? chatId : undefined);
      const memoryless = userId === undefined;
      handlers.cancelPendingTimer(timerId);
      const delivered = await handlers.fireTimer(chatId, timerId, reason, userId, memoryless);
      if (!delivered) throw new Error("Timer completed without a visible Telegram delivery");
      if (storedUserId === undefined) {
        this.logger.warn(
          { timerId, botId, chatId, inferredUserId: userId, memoryless },
          "Recovered legacy timer without owner using compatibility mode",
        );
      }
      this.logger.info(
        { timerId, botId, chatId, delayed },
        "Recovered timer fired via bot continueChat",
      );
      return;
    } else {
      this.logger.warn(
        { timerId, botId, chatId },
        "No fire handler for bot, recovered timer cannot trigger continueChat",
      );
      return Promise.reject(new Error("Bot timer handler is not ready"));
    }
  }
}
