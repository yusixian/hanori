import { mkdir, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import type {
  AiReplyBotConfig,
  AiSelectionCallbacks,
  AiSelectionSnapshot,
  BotAiSelectionRuntime,
  BotTimerHandlers,
  CosInsideAuditEntry,
  CosInsideHistoryEntry,
  CosInsideHistoryFailure,
  TelegramObservationCallbacks,
} from "@cos-tool-bot/bot";
import { removeProfileAvatarFile, resolveBotSkills } from "@cos-tool-bot/bot";
import { escapeHtml } from "@cos-tool-bot/bot/utils/format";
import type { Database } from "@cos-tool-bot/database";
import {
  bots,
  mcpServers,
  miniAppAuditEvents,
  miniAppChatGrants,
  miniAppOperatorGrants,
  pixaiGenerations,
  tokenUsage,
} from "@cos-tool-bot/database";
import type {
  AiConfigStored,
  BotMemoryCallbacks,
  BotPlatform,
  ConversationCallbacks,
  EngagementSample,
  IBotManager,
  MemoryCallbacks,
  ImageGenerationPort,
  ImageGenerationRequestSnapshot,
  PixAIConfig,
  PixAIGenerationRecord,
  TelegramRichMessageFormat,
  TelegramRichMessageReceipt,
  TelegramRichMessageSender,
  TokenUsageRecord,
  UsageGovernancePort,
  UsageResource,
  UsageScope,
  UsageWindow,
  UserPrivacyCallbacks,
} from "@cos-tool-bot/shared";
import {
  DEFAULT_CONVERSATION_CONFIG,
  DEFAULT_MEMORY_CONFIG,
  DEFAULT_TIMEOUT_CONFIG,
  IMAGE_EXTENSIONS,
  getDataDir,
} from "@cos-tool-bot/shared";
import { and, asc, eq, lte } from "drizzle-orm";
import type { Logger } from "pino";
import { createDataFilesLoader } from "../utils/data-files-loader.js";
import { env } from "../env.js";
import { tryDecrypt } from "../utils/crypto.js";
import {
  applyGroupOverride,
  applyMessageConfigUpdate,
  applyWebToolApiKey,
  toAiConfigRuntime,
} from "./ai-config-runtime.js";
import type { BackupService } from "./backup.js";
import { BotManager } from "./bot-manager.js";
import { BotMemoryStore } from "./bot-memory-store.js";
import { BotMemoryWriter, type BotMemoryChanges, type NewBotMemory } from "./bot-memory-writer.js";
import { compressConversation } from "./conversation-compressor.js";
import { ConversationHistoryGovernor } from "./conversation-history-governor.js";
import { ConversationStore } from "./conversation-store.js";
import { DbLogger } from "./db-logger.js";
import { createBotEmbeddingService, type EmbeddingService } from "./embedding-service.js";
import { ImapEmailMonitor } from "./imap-email-monitor.js";
import {
  AsyncTaskLimiter,
  confirmPendingInsertAbsent,
  isTerminalGenerationRecoveryError,
  PendingGenerationInsertFallbackTracker,
  persistTerminalGenerationClaim,
  tryPersistTerminalGenerationFailure,
} from "./generation-recovery.js";
import { LarkBotManager } from "./lark-bot-manager.js";
import { LarkWebhookClient } from "./lark-webhook-client.js";
import { KeyedAsyncLock } from "./keyed-async-lock.js";
import { PeopleProfileStore, mapProfileToDto } from "./people-profile-store.js";
import { PeopleProfileAvatarService } from "./people-profile-avatar-service.js";
import type { TelegramBotPublicProfile } from "./telegram-bot-runtime.js";
import { selectMemoriesForPrompt } from "./prompt-memory-selector.js";
import type { McpClientManager } from "./mcp-client-manager.js";
import type { RssFeedService } from "./rss-feed-service.js";
import type { TimerRegistry } from "./timer-registry.js";
import type { ChatSummaryService } from "./chat-summary-service.js";
import type { SummaryConfigService } from "./summary-config-service.js";
import type { GitWorkspaceService } from "./git-workspace-service.js";
import type { GitHubAppCredentialService } from "./github-app-credentials.js";
import type { HarnessService } from "../harness/service.js";
import {
  clampGitHubRepositories,
  GitHubCredentialGenerationGate,
} from "./github-credential-policy.js";
import {
  BotNotRunningError,
  TelegramRichMessagesUnsupportedError,
} from "./telegram-rich-message-errors.js";
import { UserPrivacyService } from "./user-privacy-service.js";
import { GenerationLibraryService } from "./generation-library-service.js";
import type { ChatAiSelectionService } from "./chat-ai-selection-service.js";
import type { EngagementSampleService } from "./engagement-sample-service.js";
import type {
  ChatAiSelectionRuntime,
  ChatAiSelectionRuntimeRegistry,
  ChatAiSelectionRuntimeSnapshot,
} from "./chat-ai-selection-runtime-registry.js";

const CONVERSATION_CLEANUP_INTERVAL_MS = 60 * 60 * 1000;
const CONVERSATION_GOVERNANCE_STARTUP_GRACE_MS = 15_000;
const GENERATION_RECOVERY_CONCURRENCY = 3;
const GENERATION_RECOVERY_BATCH_SIZE = GENERATION_RECOVERY_CONCURRENCY;
const GENERATION_RECOVERY_SWEEP_INTERVAL_MS = 60_000;
const GENERATION_IMAGE_DOWNLOAD_TIMEOUT_MS = 30_000;

function usageSnapshotLabel(resource: UsageResource, scope: UsageScope): string {
  const resourceLabel = resource === "image" ? "图片生成" : "AI 回复";
  const scopeLabel =
    scope === "bot"
      ? "Bot"
      : scope === "chat"
        ? "当前群聊"
        : scope === "user_global"
          ? "你的跨群用量"
          : "你在当前群聊";
  return `${resourceLabel} · ${scopeLabel}`;
}

function usageWindowLabel(window: UsageWindow): string {
  if (window === "minute") return "近 1 分钟";
  if (window === "hour") return "近 1 小时";
  if (window === "day") return "今日";
  return "本月";
}

function toBotAiSelectionSnapshot(snapshot: ChatAiSelectionRuntimeSnapshot): AiSelectionSnapshot {
  return {
    global: {
      activeProviderId: snapshot.global.providerId,
      activeModelId: snapshot.global.modelId,
    },
    chats: Object.fromEntries(
      [...snapshot.chats].map(([chatId, pair]) => [
        String(chatId),
        { providerId: pair.providerId, modelId: pair.modelId },
      ]),
    ),
  };
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
  private opLocks = new Map<string, Promise<unknown>>();
  private aiConfigLocks = new KeyedAsyncLock();
  private botTimerHandlers = new Map<string, BotTimerHandlers>();
  private conversationCleanupAt = new Map<string, number>();
  private conversationCleanupInFlight = new Map<string, Promise<void>>();
  private conversationCleanupSweep?: Promise<void>;
  private conversationCleanupTimer?: ReturnType<typeof setInterval>;
  private generationRecoveries = new Map<string, GenerationRecoveryEntry>();
  private generationRecoveryLimiter = new AsyncTaskLimiter(GENERATION_RECOVERY_CONCURRENCY);
  private generationRecoveryConfigs = new Map<string, GenerationRecoveryConfig>();
  private generationRecoveryEpochs = new Map<string, number>();
  private generationRecoverySweep?: Promise<void>;
  private generationRecoveryTimer?: ReturnType<typeof setInterval>;
  private generationInsertFallbacks = new PendingGenerationInsertFallbackTracker();
  private conversationStore: ConversationStore;
  private profileStore: PeopleProfileStore;
  private profileAvatarService: PeopleProfileAvatarService;
  private botMemoryStore: BotMemoryStore;
  private botMemoryWriter: BotMemoryWriter;
  private memoryEmbeddingServices = new Map<string, EmbeddingService>();
  private userPrivacyService: UserPrivacyService;
  private generationLibraryService: GenerationLibraryService;
  private chatAiSelectionService?: Pick<
    ChatAiSelectionService,
    | "loadRuntimeSnapshot"
    | "retryPublish"
    | "setModelFromTelegram"
    | "resetModelFromTelegram"
    | "setProviderFromTelegram"
    | "resetProviderFromTelegram"
  >;
  private chatAiSelectionRuntimeRegistry?: ChatAiSelectionRuntimeRegistry;
  private aiSelectionRuntimeDisposers = new Map<string, () => void>();
  private backupService?: BackupService;
  private rssFeedService?: RssFeedService;
  private mcpClientManager?: McpClientManager;
  private imageGenerationPort?: ImageGenerationPort;
  private usageGovernance?: UsageGovernancePort;
  private timerRegistry: TimerRegistry;
  private summaryService?: ChatSummaryService;
  private summaryConfigService?: SummaryConfigService;
  private gitWorkspaceService?: GitWorkspaceService;
  private githubAppCredentialService?: GitHubAppCredentialService;
  private harnessService?: HarnessService;
  private engagementSampleService?: Pick<EngagementSampleService, "persist">;
  private telegramObservation?: TelegramObservationCallbacks;
  private telegramProfileObserver?: (
    botId: string,
    profile: TelegramBotPublicProfile,
  ) => void | Promise<void>;
  private githubCredentialGenerations = new GitHubCredentialGenerationGate();

  constructor(
    private db: Database,
    private logger: Logger,
    timerRegistry: TimerRegistry,
  ) {
    this.timerRegistry = timerRegistry;
    this.conversationStore = new ConversationStore(db);
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
  }

  setChatAiSelectionService(
    service: NonNullable<BotPool["chatAiSelectionService"]>,
    runtimeRegistry: ChatAiSelectionRuntimeRegistry,
  ): void {
    this.chatAiSelectionService = service;
    this.chatAiSelectionRuntimeRegistry = runtimeRegistry;
  }

  setBackupService(service: BackupService) {
    this.backupService = service;
  }

  getGenerationLibraryService(): GenerationLibraryService {
    return this.generationLibraryService;
  }

  setMcpClientManager(manager: McpClientManager) {
    this.mcpClientManager = manager;
  }

  setImageGenerationPort(port: ImageGenerationPort) {
    this.imageGenerationPort = port;
  }

  setUsageGovernance(port: UsageGovernancePort) {
    this.usageGovernance = port;
  }

  setRssFeedService(service: RssFeedService) {
    this.rssFeedService = service;
    service.setDigestTrigger((botId, chatId, eventDescription) =>
      this.fireRssDigest(botId, chatId, eventDescription),
    );
  }

  setSummaryService(svc: ChatSummaryService) {
    this.summaryService = svc;
  }

  setSummaryConfigService(svc: SummaryConfigService) {
    this.summaryConfigService = svc;
  }

  setGitWorkspaceService(service: GitWorkspaceService) {
    this.gitWorkspaceService = service;
  }

  setGitHubAppCredentialService(service: GitHubAppCredentialService) {
    this.githubAppCredentialService = service;
  }

  setHarnessService(service: HarnessService) {
    this.harnessService = service;
  }

  setEngagementSampleService(service: Pick<EngagementSampleService, "persist">) {
    this.engagementSampleService = service;
  }

  private async persistEngagementSample(
    botId: string,
    sample: EngagementSample,
    secrets: readonly string[],
  ): Promise<void> {
    const engagementSampleService = this.engagementSampleService;
    if (!engagementSampleService) return;
    await this.userPrivacyService.runWithEngagementContextPrivacy(
      botId,
      sample.context,
      (context) => engagementSampleService.persist(botId, { ...sample, context }, secrets),
    );
  }

  setTelegramDirectoryCallbacks(
    observation: TelegramObservationCallbacks,
    profileObserver: (botId: string, profile: TelegramBotPublicProfile) => void | Promise<void>,
  ) {
    this.telegramObservation = observation;
    this.telegramProfileObserver = profileObserver;
  }

  invalidateGitHubCredentials(botId: string): void {
    this.githubCredentialGenerations.invalidate(botId);
  }

  getSummaryService() {
    return this.summaryService;
  }

  getSummaryConfigService() {
    return this.summaryConfigService;
  }

  async sendHtml(botId: string, chatId: number, html: string): Promise<void> {
    const manager = this.managers.get(botId);
    if (!manager) {
      this.logger.warn({ botId, chatId }, "sendHtml: no manager for bot");
      return;
    }
    await manager.sendHtml(chatId, html);
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
    },
  ): Promise<number[]> {
    const manager = this.managers.get(botId);
    if (!manager) throw new Error(`Bot ${botId} is not running`);
    if (!(manager instanceof BotManager)) throw new Error(`Bot ${botId} does not support images`);
    return manager.sendImageFiles(chatId, files, input);
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

  private runConversationCleanup(
    botId: string,
    retentionDays: number,
    force = false,
  ): Promise<void> {
    if (retentionDays <= 0) return Promise.resolve();

    const existing = this.conversationCleanupInFlight.get(botId);
    if (existing) return existing;

    const now = Date.now();
    const lastCleanupAt = this.conversationCleanupAt.get(botId) ?? 0;
    if (!force && now - lastCleanupAt < CONVERSATION_CLEANUP_INTERVAL_MS) {
      return Promise.resolve();
    }

    this.conversationCleanupAt.set(botId, now);
    const cleanup = this.conversationStore
      .cleanup(botId, retentionDays)
      .catch((err) => {
        if (this.conversationCleanupAt.get(botId) === now) {
          this.conversationCleanupAt.delete(botId);
        }
        this.logger.warn(err, `Conversation retention cleanup failed for bot=${botId}`);
      })
      .finally(() => {
        if (this.conversationCleanupInFlight.get(botId) === cleanup) {
          this.conversationCleanupInFlight.delete(botId);
        }
      });
    this.conversationCleanupInFlight.set(botId, cleanup);
    return cleanup;
  }

  private triggerConversationCleanup(botId: string, retentionDays: number) {
    void this.runConversationCleanup(botId, retentionDays);
  }

  private runConversationCleanupSweep(
    activeBots?: Array<Pick<typeof bots.$inferSelect, "id" | "aiConfig">>,
    force = false,
  ): Promise<void> {
    if (this.conversationCleanupSweep) return this.conversationCleanupSweep;

    const sweep = (async () => {
      const currentBots =
        activeBots ??
        (await this.db
          .select({ id: bots.id, aiConfig: bots.aiConfig })
          .from(bots)
          .where(eq(bots.isActive, true)));

      await Promise.all(
        currentBots.map((bot) =>
          this.runConversationCleanup(
            bot.id,
            bot.aiConfig?.conversationConfig?.retentionDays ??
              DEFAULT_CONVERSATION_CONFIG.retentionDays,
            force,
          ),
        ),
      );
    })().finally(() => {
      if (this.conversationCleanupSweep === sweep) {
        this.conversationCleanupSweep = undefined;
      }
    });
    this.conversationCleanupSweep = sweep;
    return sweep;
  }

  private startConversationCleanupScheduler() {
    if (this.conversationCleanupTimer) return;

    this.conversationCleanupTimer = setInterval(() => {
      void this.runConversationCleanupSweep().catch((err) => {
        this.logger.warn(err, "Conversation retention sweep failed");
      });
    }, CONVERSATION_CLEANUP_INTERVAL_MS);
    this.conversationCleanupTimer.unref();
  }

  private stopConversationCleanupScheduler() {
    if (!this.conversationCleanupTimer) return;
    clearInterval(this.conversationCleanupTimer);
    this.conversationCleanupTimer = undefined;
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
      activeBots = await this.db.select().from(bots).where(eq(bots.isActive, true));
    } catch (err) {
      this.logger.warn(err, "Failed to query active bots (table may not exist — run migrations)");
      return;
    }

    this.startConversationCleanupScheduler();
    void this.runConversationCleanupSweep(activeBots, true).catch((err) => {
      this.logger.warn(err, "Conversation retention startup sweep failed");
    });

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
    this.stopConversationCleanupScheduler();
    this.generationRecoveryConfigs.clear();
    this.stopGenerationRecoverySchedulerIfIdle();
    if (this.conversationCleanupSweep) {
      await Promise.allSettled([this.conversationCleanupSweep]);
    }
    await Promise.allSettled(this.conversationCleanupInFlight.values());

    const ids = [...this.managers.keys()];
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

  private enqueue<T>(botId: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.opLocks.get(botId) ?? Promise.resolve();
    const result = prev.then(fn, fn);
    const done = result.then(
      () => {},
      () => {},
    );
    this.opLocks.set(botId, done);
    void done.then(() => {
      if (this.opLocks.get(botId) === done) this.opLocks.delete(botId);
    });
    return result;
  }

  withAiConfigLock<T>(botId: string, operation: () => Promise<T>): Promise<T> {
    return this.aiConfigLocks.run(botId, operation);
  }

  /** Returns false when the bot has no stored AI config; no write happens. */
  private async updateStoredAiConfig(
    botId: string,
    mutate: (current: AiConfigStored) => AiConfigStored,
  ): Promise<boolean> {
    return this.withAiConfigLock(botId, () =>
      this.db.transaction(async (tx) => {
        const [current] = await tx.select().from(bots).where(eq(bots.id, botId));
        if (!current?.aiConfig) return false;
        await tx
          .update(bots)
          .set({ aiConfig: mutate(current.aiConfig) })
          .where(eq(bots.id, botId));
        return true;
      }),
    );
  }

  async startBot(botId: string) {
    return this.enqueue(botId, () => this.startBotImpl(botId));
  }

  private async startBotImpl(botId: string) {
    const [bot] = await this.db.select().from(bots).where(eq(bots.id, botId));
    if (!bot) throw new Error(`Bot ${botId} not found`);
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

    const platform: BotPlatform = bot.platform === "lark-webhook" ? "lark-webhook" : "telegram";
    if (platform === "lark-webhook") {
      await this.startLarkWebhookBot(botId, bot);
      return;
    }

    // Telegram bot flow
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
    const privacyService = this.userPrivacyService;
    const privacy: UserPrivacyCallbacks = {
      getMode: (userId) => privacyService.getMode(botId, userId),
      getContextResetAt: (userId) => privacyService.getContextResetAt(botId, userId),
      runExclusive: (userId, operation) => privacyService.runExclusive(botId, userId, operation),
      setMode: (userId, mode) => privacyService.setMode(botId, userId, mode),
      forget: async (userId) => {
        await privacyService.setMode(botId, userId, "off");
        const avatarPaths = await privacyService.getAvatarPaths(botId, userId);
        try {
          for (const avatarPath of avatarPaths) {
            await removeProfileAvatarFile(getDataDir(botId), avatarPath);
          }
        } catch (error) {
          dbLogger.warn("Failed to remove profile avatar during privacy forget", {
            userId,
            error: error instanceof Error ? error.message : String(error),
          });
          throw error;
        }
        const result = await privacyService.forget(botId, userId);
        return {
          conversationMessages: result.conversationMessages,
          profiles: result.profiles,
          personalMemories: result.personalMemories,
        };
      },
    };

    // Build AI reply config if configured
    let aiReply: AiReplyBotConfig | undefined;
    let embeddingService: EmbeddingService | undefined;
    let aiSelectionCallbacks: AiSelectionCallbacks | undefined;
    let conversation: ConversationCallbacks | undefined;
    let runInitialHistoryGovernance: (() => Promise<void>) | undefined;
    const aiRuntime = toAiConfigRuntime(bot.aiConfig, env.ENCRYPTION_KEY);
    const aiConfig = aiRuntime?.config ?? null;
    const runtimeTimeoutConfig = aiRuntime?.timeoutConfig;
    const auxiliaryTimeoutMs = runtimeTimeoutConfig?.perStepMs ?? DEFAULT_TIMEOUT_CONFIG.perStepMs;
    const providersRuntime = aiRuntime?.providers ?? [];
    const activeProvider = aiRuntime?.activeProvider;
    if (aiRuntime && aiConfig?.enabled && activeProvider) {
      const apiKey = activeProvider.apiKey;
      const storedGitHubConfig = aiConfig.githubToolsConfig;
      const installation = storedGitHubConfig?.githubAppInstallation;
      const legacyGitHubToken = aiRuntime.githubToken;
      const githubCredentialResolver =
        installation && this.githubAppCredentialService?.available
          ? () => this.githubAppCredentialService!.getInstallationToken(installation.installationId)
          : legacyGitHubToken
            ? async () => legacyGitHubToken
            : undefined;
      const githubToolsConfig = storedGitHubConfig
        ? {
            enabled: storedGitHubConfig.enabled,
            publicReadEnabled: storedGitHubConfig.publicReadEnabled,
            codingAgentEnabled: storedGitHubConfig.codingAgentEnabled ?? false,
            codingProviderId: storedGitHubConfig.codingProviderId,
            codingModelId: storedGitHubConfig.codingModelId,
            githubAppInstallation: installation,
            login: installation?.accountLogin ?? storedGitHubConfig.login,
            authorName: storedGitHubConfig.authorName,
            authorEmail: storedGitHubConfig.authorEmail,
            repositories: clampGitHubRepositories(storedGitHubConfig.repositories, installation),
            tokenProvider: githubCredentialResolver
              ? this.githubCredentialGenerations.capture(botId, githubCredentialResolver)
              : undefined,
          }
        : undefined;
      if (aiRuntime.githubTokenDecryptFailed) {
        dbLogger.warn(
          "GitHub credential cannot be decrypted; private repository and write access disabled.",
        );
      }
      if (
        storedGitHubConfig &&
        githubToolsConfig &&
        githubToolsConfig.repositories.length !== storedGitHubConfig.repositories.length
      ) {
        dbLogger.warn(
          "GitHub repository allowlist contained entries outside the installation snapshot; runtime access was clamped.",
        );
      }
      const skippedNoKey = aiRuntime.skippedProviders.noKey;
      const skippedDecryptFail = aiRuntime.skippedProviders.decryptFailed;
      if (skippedNoKey.length > 0) {
        dbLogger.warn(`AI providers skipped (no API key configured): ${skippedNoKey.join(", ")}`);
      }
      if (skippedDecryptFail.length > 0) {
        dbLogger.warn(
          `AI providers skipped (encryption key mismatch, cannot decrypt): ${skippedDecryptFail.join(", ")}`,
        );
      }
      const conversationCfg = {
        ...DEFAULT_CONVERSATION_CONFIG,
        ...aiConfig.conversationConfig,
      };
      const compressionProvider = conversationCfg.compressionProviderId
        ? (providersRuntime.find(
            (provider) => provider.id === conversationCfg.compressionProviderId,
          ) ?? activeProvider)
        : activeProvider;
      if (
        conversationCfg.compressionProviderId &&
        compressionProvider.id !== conversationCfg.compressionProviderId
      ) {
        dbLogger.warn(
          `Conversation compression Provider ${conversationCfg.compressionProviderId} is unavailable; using the active Provider`,
        );
      }
      const store = this.conversationStore;
      const historyGovernor = new ConversationHistoryGovernor(store, {
        warn: (meta: unknown, message?: string) => {
          void dbLogger.warn(String(message), meta);
        },
      });
      const governChat = (chatId: number, summaryGraceMs?: number) =>
        historyGovernor.run({
          botId,
          chatId,
          maxRawMessagesPerChat: conversationCfg.maxRawMessagesPerChat,
          summaryGraceMs,
          summarize: () =>
            compressConversation({
              botId,
              chatId,
              store,
              conversationConfig: conversationCfg,
              apiKey: compressionProvider.apiKey,
              baseURL: compressionProvider.baseURL,
              model: compressionProvider.defaultModel,
              providerFormat: compressionProvider.providerFormat,
              logger: this.logger,
              abortSignal: AbortSignal.timeout(auxiliaryTimeoutMs),
            }),
        });
      const ensureChatCompression = (chatId: number) =>
        compressConversation({
          botId,
          chatId,
          store,
          conversationConfig: conversationCfg,
          apiKey: compressionProvider.apiKey,
          baseURL: compressionProvider.baseURL,
          model: compressionProvider.defaultModel,
          providerFormat: compressionProvider.providerFormat,
          logger: this.logger,
          force: true,
          keepRecent: 0,
          abortSignal: AbortSignal.timeout(auxiliaryTimeoutMs),
        });
      runInitialHistoryGovernance = async () => {
        if (conversationCfg.maxRawMessagesPerChat <= 0) return;
        const warningThreshold = Math.floor(conversationCfg.maxRawMessagesPerChat * 0.8);
        const chats = await store.listChatsAtOrAboveMessageCount(botId, warningThreshold);
        const hardLimitFirst = chats.sort((left, right) => right.count - left.count);
        for (const chat of hardLimitFirst) {
          await governChat(chat.chatId, CONVERSATION_GOVERNANCE_STARTUP_GRACE_MS);
        }
      };

      // Create embedding service early so closures can reference it
      embeddingService = createBotEmbeddingService(aiRuntime, this.logger);
      if (aiRuntime.embeddingApiKeyDecryptFailed) {
        dbLogger.warn(
          "Encryption key mismatch: cannot decrypt embedding API key. Embedding features disabled.",
        );
      }
      if (aiRuntime.engagementApiKeyDecryptFailed) {
        dbLogger.warn(
          "Engagement API key cannot be decrypted; JEV decisions will use the legacy fallback.",
        );
      } else if (aiRuntime.engagement.mode !== "off" && !aiRuntime.engagement.apiKey) {
        dbLogger.warn(
          "Engagement mode is enabled without an API key; JEV decisions will use the legacy fallback.",
        );
      }

      conversation = {
        getHistory: (chatId, limit, tokenBudget, options) =>
          store.getHistory(botId, chatId, limit, tokenBudget, options),
        getRecentUserMessagesAcrossChats: (userId, excludeChatId, limit, beforeId) =>
          store.getRecentUserMessagesAcrossChats(botId, userId, excludeChatId, limit, beforeId),
        getHistoryWatermark: () => store.getHistoryWatermark(botId),
        addMessage: (p) => store.addMessage({ botId, ...p }),
        addMessages: async (msgs) => {
          const persisted = await store.addMessages(msgs.map((m) => ({ botId, ...m })));
          if (embeddingService && persisted.length > 0) {
            const toEmbed = persisted.filter(
              (message) =>
                message.content.length > 0 &&
                (message.role === "user" || message.role === "assistant"),
            );
            if (toEmbed.length > 0) {
              try {
                const embeddings = await embeddingService.generateEmbeddings(
                  toEmbed.map((message) => message.content),
                  AbortSignal.timeout(auxiliaryTimeoutMs),
                );
                for (let i = 0; i < embeddings.length; i++) {
                  const emb = embeddings[i];
                  if (emb) {
                    await store.updateEmbedding(toEmbed[i]!.id, emb);
                  }
                }
              } catch (err) {
                this.logger.warn(err, "Batch message embedding generation failed");
              }
            }
          }
        },
        upsertUserMessage: async (message) => {
          const persisted = await store.upsertUserMessage({ botId, ...message });
          if (embeddingService && persisted?.content) {
            embeddingService
              .generateEmbedding(persisted.content, AbortSignal.timeout(auxiliaryTimeoutMs))
              .then((embedding) => {
                if (embedding) return store.updateEmbedding(persisted.id, embedding);
              })
              .catch((err) => {
                this.logger.warn(err, "Group message embedding generation failed");
              });
          }
          return persisted ? { id: persisted.id } : undefined;
        },
        completeTurn: async (chatId, sourceKey, turnOrderId) => {
          const completed = await store.completeTurn(botId, chatId, sourceKey, turnOrderId);
          if (!completed) {
            throw new Error(
              `Failed to complete conversation turn for chat=${chatId}: source row missing`,
            );
          }
        },
        completeTurns: async (chatId, sourceKeys, turnOrderId) => {
          const completed = await store.completeTurns(botId, chatId, sourceKeys, turnOrderId);
          if (!completed) {
            throw new Error(
              `Failed to complete logical conversation turn for chat=${chatId}: source rows missing`,
            );
          }
        },
        ensureCompression: async (chatId) => {
          this.triggerConversationCleanup(botId, conversationCfg.retentionDays);
          await ensureChatCompression(chatId);
        },
        triggerCompression: async (chatId) => {
          this.triggerConversationCleanup(botId, conversationCfg.retentionDays);
          try {
            await governChat(chatId);
          } catch (err) {
            void dbLogger.error(
              `Conversation history governance failed for chat=${chatId}: ${err instanceof Error ? err.message : String(err)}`,
              { chatId },
            );
          }
        },
        clearHistory: (chatId) => store.clearHistory(botId, chatId),
      };

      // Build memory callbacks if memory is enabled
      const memoryCfg = aiConfig.memoryConfig ?? DEFAULT_MEMORY_CONFIG;
      let memory: MemoryCallbacks | undefined;
      if (memoryCfg.enabled) {
        const ps = this.profileStore;
        const cs = this.conversationStore;
        memory = {
          getProfile: (telegramId) =>
            ps.getProfile(botId, telegramId).then((p) => (p ? mapProfileToDto(p) : null)),
          getProfileAvatar: (telegramId, requesterTelegramId) =>
            this.profileAvatarService.getProfileAvatar(
              botId,
              getDataDir(botId),
              telegramId,
              requesterTelegramId,
            ),
          upsertProfile: (data) => ps.upsertProfile(botId, data).then(mapProfileToDto),
          searchProfiles: (query) =>
            ps.searchProfiles(botId, query).then((profiles) => profiles.map(mapProfileToDto)),
          searchHistory: async (params) => {
            let queryEmbedding: number[] | undefined;
            if (embeddingService && params.query) {
              const emb = await embeddingService.generateEmbedding(
                params.query,
                AbortSignal.timeout(auxiliaryTimeoutMs),
              );
              if (emb) queryEmbedding = emb;
            }
            return cs.searchMessages(botId, { ...params, queryEmbedding });
          },
          touchProfile: (observation) => ps.touchProfile(botId, observation),
          beginProfileAvatarRefresh: (refresh) => ps.beginProfileAvatarRefresh(botId, refresh),
          updateProfileAvatar: (update) => ps.updateProfileAvatar(botId, update),
        };
      }

      // Build bot memory callbacks (independent of people profile memory)
      const botMemoryCfg = aiConfig.botMemoryConfig;
      let botMemory: BotMemoryCallbacks | undefined;
      if (botMemoryCfg?.enabled) {
        const ms = this.botMemoryStore;
        const es = embeddingService;
        // Turns can run before start() returns and registers `es` for the Pool-level writer.
        const memoryWriter = new BotMemoryWriter(ms, () => es, this.logger);

        botMemory = {
          saveMemory: (params) =>
            memoryWriter.create(botId, params, {
              dedup: true,
              embeddingTimeoutMs: auxiliaryTimeoutMs,
            }),
          recallMemories: async (params) => {
            let queryEmbedding: number[] | undefined;
            if (es && params.query) {
              const emb = await es.generateEmbedding(
                params.query,
                AbortSignal.timeout(auxiliaryTimeoutMs),
              );
              if (emb) queryEmbedding = emb;
            }
            return ms.recallMemories(botId, { ...params, queryEmbedding });
          },
          updateMemory: (memoryId, data, access) =>
            memoryWriter.update(botId, memoryId, data, {
              access,
              embeddingTimeoutMs: auxiliaryTimeoutMs,
            }),
          retireMemory: (memoryId, supersededById, access, expectedContent) =>
            ms.retireMemory(botId, memoryId, supersededById, access, expectedContent),
          deleteMemory: (memoryId, access) => ms.deleteMemory(botId, memoryId, access),
          getMemoriesForPrompt: (telegramId, limit, scopeChatId, includeUnscopedPersonal) =>
            ms.getMemoriesForPrompt(botId, {
              telegramId,
              scopeChatId,
              includeUnscopedPersonal,
              limit: limit ?? botMemoryCfg.maxMemories,
            }),
          getMemoriesForQuery: (params) =>
            selectMemoriesForPrompt({
              botId,
              query: params.query,
              telegramId: params.telegramId,
              scopeChatId: params.scopeChatId,
              includeUnscopedPersonal: params.includeUnscopedPersonal,
              limit: params.limit ?? botMemoryCfg.maxMemories,
              store: ms,
              embeddingService: es,
            }),
          searchProfiles: async (query, telegramId) => {
            const pStore = this.profileStore;
            const [exactProfile, searched] = await Promise.all([
              telegramId != null ? pStore.getProfile(botId, telegramId) : null,
              pStore.searchProfiles(botId, query),
            ]);
            const results = searched.map(mapProfileToDto);
            if (exactProfile && !results.some((r) => r.telegramId === exactProfile.telegramId)) {
              results.unshift(mapProfileToDto(exactProfile));
            }
            return results;
          },
        };
      }

      const durableSelection = this.chatAiSelectionService
        ? await this.chatAiSelectionService.loadRuntimeSnapshot(botId)
        : undefined;
      if (this.chatAiSelectionService && this.chatAiSelectionRuntimeRegistry) {
        const service = this.chatAiSelectionService;
        const registry = this.chatAiSelectionRuntimeRegistry;
        aiSelectionCallbacks = {
          setModel: (chatId, modelId, actorTelegramUserId) =>
            service.setModelFromTelegram(botId, chatId, modelId, actorTelegramUserId),
          resetModel: (chatId, actorTelegramUserId) =>
            service.resetModelFromTelegram(botId, chatId, actorTelegramUserId),
          setProvider: (chatId, providerId, actorTelegramUserId) =>
            service.setProviderFromTelegram(botId, chatId, providerId, actorTelegramUserId),
          resetProvider: (chatId, actorTelegramUserId) =>
            service.resetProviderFromTelegram(botId, chatId, actorTelegramUserId),
          onBotReady: (runtime: BotAiSelectionRuntime) => {
            this.aiSelectionRuntimeDisposers.get(botId)?.();
            const adapter: ChatAiSelectionRuntime = {
              apply: async (snapshot) => {
                runtime.applyAiSelectionSnapshot(toBotAiSelectionSnapshot(snapshot));
              },
            };
            this.aiSelectionRuntimeDisposers.set(botId, registry.register(botId, adapter));
          },
        };
      }

      // Build data files config for prompt injection and file tools
      const dataFilesConfig = aiConfig.dataFilesConfig;
      const dataFiles = await createDataFilesLoader(botId, {
        injectableFiles: dataFilesConfig?.injectableFiles,
        maxTotalSize: dataFilesConfig?.maxTotalSize,
      });

      aiReply = {
        botId,
        apiKey,
        baseURL: activeProvider.baseURL,
        model: aiConfig.activeModelId ?? activeProvider.defaultModel,
        providerFormat: activeProvider.providerFormat,
        providers: providersRuntime,
        activeProviderId: activeProvider.id,
        activeModelId: aiConfig.activeModelId ?? activeProvider.defaultModel,
        aiSelectionSnapshot: durableSelection
          ? toBotAiSelectionSnapshot(durableSelection)
          : undefined,
        systemPrompt: aiConfig.systemPrompt,
        behavioralPrompt: aiConfig.behavioralPrompt,
        groupBehavioralPrompt: aiConfig.groupBehavioralPrompt,
        triggerConfig: aiConfig.triggerConfig,
        engagement: aiRuntime.engagement,
        onEngagementSample: async (sample) => {
          if (!this.engagementSampleService) return;
          try {
            await this.persistEngagementSample(
              botId,
              sample,
              [
                aiRuntime.engagement.apiKey,
                ...providersRuntime.map((provider) => provider.apiKey),
              ].filter((secret): secret is string => !!secret),
            );
          } catch (error) {
            this.logger.error({ error, botId }, "Failed to persist engagement sample");
          }
        },
        groupOverrides: aiConfig.groupOverrides,
        conversationConfig: conversationCfg,
        conversation,
        memoryConfig: memoryCfg,
        memory,
        stickerPacks: aiConfig.stickerPacks,
        webToolsConfig: aiConfig.webToolsConfig,
        imageGenerationPort: this.imageGenerationPort,
        generationLibraryPort: this.generationLibraryService,
        skills: resolveBotSkills(aiConfig.skillConfig),
        isDelegatedGroupAdmin: (chatId, userId) =>
          this.isDelegatedGroupAdmin(botId, chatId, userId),
        usageGovernance: this.usageGovernance,
        agentToolsConfig: aiConfig.agentToolsConfig,
        githubToolsConfig,
        githubCodeCallbacks:
          githubToolsConfig?.codingAgentEnabled &&
          githubToolsConfig.tokenProvider &&
          this.gitWorkspaceService
            ? {
                runTask: async (input, model, signal) => {
                  const token = await githubToolsConfig.tokenProvider!();
                  if (!token) throw new Error("Ai-chan's GitHub credential is not configured");
                  return this.gitWorkspaceService!.runCodeTask(
                    {
                      ...input,
                      botId,
                      token,
                      authorName: githubToolsConfig.authorName,
                      authorEmail: githubToolsConfig.authorEmail,
                      model,
                    },
                    signal,
                  );
                },
                previewPush: async (repository, branch, signal) => {
                  const token = await githubToolsConfig.tokenProvider!();
                  if (!token) throw new Error("Ai-chan's GitHub credential is not configured");
                  return this.gitWorkspaceService!.previewPush(
                    {
                      botId,
                      repository,
                      branch,
                      token,
                    },
                    signal,
                  );
                },
                pushBranch: async (repository, branch, expectedCommitSha, signal) => {
                  const token = await githubToolsConfig.tokenProvider!();
                  if (!token) throw new Error("Ai-chan's GitHub credential is not configured");
                  return this.gitWorkspaceService!.pushBranch(
                    {
                      botId,
                      repository,
                      branch,
                      token,
                      expectedCommitSha,
                    },
                    signal,
                  );
                },
                inspectWorkspace: (repository, signal) =>
                  this.gitWorkspaceService!.inspectWorkspace({ botId, repository }, signal),
                resumeWorkspace: (input, model, expected, signal) =>
                  this.gitWorkspaceService!.resumeWorkspace(
                    {
                      ...input,
                      botId,
                      authorName: githubToolsConfig.authorName,
                      authorEmail: githubToolsConfig.authorEmail,
                      model,
                    },
                    expected,
                    signal,
                  ),
                discardWorkspace: (repository, expected, signal) =>
                  this.gitWorkspaceService!.discardWorkspace(
                    { botId, repository },
                    expected,
                    signal,
                  ),
              }
            : undefined,
        artworkToolsConfig: aiConfig.artworkToolsConfig,
        botMemoryConfig: botMemoryCfg,
        botMemory,
        messageConfig: aiConfig.messageConfig,
        executionConfig: aiConfig.executionConfig,
        imageOcrConfig: aiConfig.imageOcrConfig,
        timeoutConfig: runtimeTimeoutConfig,
        models: activeProvider.models ?? aiConfig.models,
        modelCommandAccess: aiConfig.modelCommandAccess,
        dataFiles,
        privateChatAccess: aiConfig.privateChatAccess,
        privateChatWhitelist: aiConfig.privateChatWhitelist,
        onGroupOverrideUpdate: async (chatId, override) => {
          try {
            await this.updateStoredAiConfig(botId, (current) =>
              applyGroupOverride(current, chatId, override),
            );
          } catch (err) {
            this.logger.error(err, "Failed to persist group override update");
          }
        },
        onMessageConfigUpdate: async (updates) => {
          try {
            const updated = await this.updateStoredAiConfig(botId, (current) =>
              applyMessageConfigUpdate(current, updates),
            );
            if (!updated) throw new Error("AI is not configured");
          } catch (error) {
            this.logger.error(error, "Failed to persist message config update");
            throw error;
          }
        },
        onWebToolApiKeyUpdate: async (target, apiKey) => {
          const updated = await this.updateStoredAiConfig(botId, (current) =>
            applyWebToolApiKey(current, target, apiKey),
          );
          if (!updated) throw new Error("Web tools are not configured");
        },
        rssCallbacks: this.rssFeedService ? this.buildRssCallbacks(botId) : undefined,
        mcpTools: this.buildMcpToolsConfig(aiConfig.mcpServerIds),
      };
    }

    const backupSvc = this.backupService;
    const onBackup = backupSvc
      ? async () => {
          try {
            const record = await backupSvc.createBackup();
            return { ok: true, filename: record.filename };
          } catch (err) {
            return { ok: false, error: err instanceof Error ? err.message : String(err) };
          }
        }
      : undefined;

    const onTokenUsage = async (entry: TokenUsageRecord) => {
      try {
        await this.db.insert(tokenUsage).values({ botId, ...entry });
      } catch (err) {
        this.logger.error(err, "Failed to write token usage");
      }
    };

    const onGenerationTrack = async (record: PixAIGenerationRecord) => {
      try {
        if (record.status === "pending") {
          try {
            await this.db.insert(pixaiGenerations).values({
              botId,
              chatId: record.chatId,
              userId: record.userId,
              taskId: record.taskId,
              prompt: record.prompt,
              negativePrompt: record.negativePrompt,
              modelId: record.modelId,
              width: record.width,
              height: record.height,
              batchSize: record.batchSize,
              samplingSteps: record.samplingSteps,
              cfgScale: record.cfgScale,
              promptHelper: record.promptHelper,
              pixaiConfig: record.pixaiConfig,
              status: record.status,
            });
            this.generationInsertFallbacks.clear(botId, record.taskId);
          } catch (err) {
            try {
              const confirmedAbsent = await confirmPendingInsertAbsent(async () => {
                const [existing] = await this.db
                  .select({ id: pixaiGenerations.id })
                  .from(pixaiGenerations)
                  .where(
                    and(
                      eq(pixaiGenerations.botId, botId),
                      eq(pixaiGenerations.taskId, record.taskId),
                    ),
                  );
                return existing;
              });
              if (confirmedAbsent) {
                this.generationInsertFallbacks.markPendingInsertFailure(botId, record.taskId);
              } else {
                this.generationInsertFallbacks.clear(botId, record.taskId);
              }
            } catch {
              // The insert and verification both had transient failures. Keep a
              // bounded marker so terminal persistence can safely re-check later.
              this.generationInsertFallbacks.markPendingInsertFailure(botId, record.taskId);
            }
            throw err;
          }
        } else {
          await this.persistTerminalGeneration(botId, record);
        }
      } catch (err) {
        this.logger.error(err, "Failed to write PixAI generation record");
        throw err;
      }
    };

    const registry = this.timerRegistry;
    const timerCallbacks = {
      onTimerCreate: async (params: {
        timerId: string;
        chatId: number;
        seconds: number;
        reason: string;
        userId: number;
        handle: ReturnType<typeof setTimeout>;
      }) => {
        await registry.registerAi({
          timerId: params.timerId,
          botId,
          chatId: params.chatId,
          name: params.reason,
          seconds: params.seconds,
          meta: { reason: params.reason, userId: params.userId },
          handle: params.handle,
          onFire: (timerId, ownerBotId, chatId, meta, delayed) =>
            this.fireRecoveredTimer(timerId, ownerBotId, chatId, meta, delayed),
        });
      },
      onTimerCancel: (timerId: string) => {
        registry.cancel(timerId).catch((err) => {
          this.logger.error(err, `Failed to cancel timer ${timerId} in registry`);
        });
      },
      onTimerFired: async (timerId: string) => {
        await registry.markFired(timerId).catch((err) => {
          this.logger.error(err, `Failed to mark timer ${timerId} fired in registry`);
          throw err;
        });
      },
      onGetTimers: () => this.getActiveTimersForBot(botId),
      onCancelTimer: (timerId: string) => this.cancelTimerForBot(botId, timerId),
      onBotReady: (handlers: import("@cos-tool-bot/bot").BotTimerHandlers) => {
        this.botTimerHandlers.set(botId, handlers);
      },
    };

    const mcpCallbacks = this.mcpClientManager
      ? {
          listServers: async () => {
            const allServers = await this.db
              .select()
              .from(mcpServers)
              .where(eq(mcpServers.isActive, true));
            const [currentBot] = await this.db.select().from(bots).where(eq(bots.id, botId));
            const enabledIds = new Set(currentBot?.aiConfig?.mcpServerIds ?? []);
            const statuses = this.mcpClientManager!.getStatus();
            const statusMap = new Map(statuses.map((s) => [s.serverId, s]));
            return allServers.map((s) => ({
              id: s.id,
              name: s.name,
              connected: statusMap.get(s.id)?.connected ?? false,
              toolCount: statusMap.get(s.id)?.toolCount ?? 0,
              enabled: enabledIds.has(s.id),
              error: statusMap.get(s.id)?.error ?? null,
            }));
          },
          addServer: async (serverId: number) => {
            const [server] = await this.db
              .select()
              .from(mcpServers)
              .where(eq(mcpServers.id, serverId));
            if (!server) return { ok: false as const, error: "服务器不存在" };
            const result = await this.withAiConfigLock(botId, async () => {
              const [current] = await this.db.select().from(bots).where(eq(bots.id, botId));
              if (!current?.aiConfig) return { ok: false as const, error: "AI 未配置" };
              const ids = new Set(current.aiConfig.mcpServerIds ?? []);
              if (ids.has(serverId)) return { ok: false as const, error: "已启用" };
              ids.add(serverId);
              await this.db
                .update(bots)
                .set({ aiConfig: { ...current.aiConfig, mcpServerIds: [...ids] } })
                .where(eq(bots.id, botId));
              return { ok: true as const };
            });
            if (result.ok) setTimeout(() => this.restartBot(botId).catch(() => {}), 2000);
            return result;
          },
          removeServer: async (serverId: number) => {
            const result = await this.withAiConfigLock(botId, async () => {
              const [current] = await this.db.select().from(bots).where(eq(bots.id, botId));
              if (!current?.aiConfig) return { ok: false as const, error: "AI 未配置" };
              const ids = new Set(current.aiConfig.mcpServerIds ?? []);
              if (!ids.has(serverId)) return { ok: false as const, error: "未启用" };
              ids.delete(serverId);
              await this.db
                .update(bots)
                .set({ aiConfig: { ...current.aiConfig, mcpServerIds: [...ids] } })
                .where(eq(bots.id, botId));
              return { ok: true as const };
            });
            if (result.ok) setTimeout(() => this.restartBot(botId).catch(() => {}), 2000);
            return result;
          },
        }
      : undefined;

    const summaryCallbacks =
      this.summaryService && this.summaryConfigService
        ? {
            botId,
            adminChatIds: bot.adminChatIds ?? [],
            triggerManual: (opts: Parameters<ChatSummaryService["triggerManual"]>[0]) =>
              this.summaryService!.triggerManual(opts),
            getAccessMode: async (chatId: number) => {
              const cfg = await this.summaryConfigService!.getByChat(botId, chatId);
              return cfg?.accessMode ?? null;
            },
          }
        : undefined;

    const cosInsideTargets = bot.cosInsideConfig?.targets ?? [];
    const cosInsideHistory =
      conversation && aiReply
        ? {
            isEnabled: (targetChatId: number) => {
              const targetOverride = aiReply.groupOverrides[String(targetChatId)];
              const conversationConfig = {
                ...DEFAULT_CONVERSATION_CONFIG,
                ...aiReply.conversationConfig,
              };
              return (
                (targetOverride?.enabled ?? true) &&
                (targetOverride?.conversationEnabled ?? conversationConfig.enabled)
              );
            },
            save: async (entry: CosInsideHistoryEntry) => {
              await conversation.addMessage({
                chatId: entry.targetChatId,
                role: "context",
                content: entry.body,
                userId: entry.actorUserId,
                userName: entry.actorName,
                sourceKey: `telegram:${entry.tgMessageId}:cosinside`,
                meta: {
                  source: "cosinside",
                  initiatorTelegramId: entry.actorUserId,
                  initiatorName: entry.actorName,
                  tgMessageId: entry.tgMessageId,
                  publicGroupHistory: true,
                  ...(entry.replyToMessageId === undefined
                    ? {}
                    : { replyToMessageId: entry.replyToMessageId }),
                },
              });
              void Promise.resolve()
                .then(() => conversation.triggerCompression(entry.targetChatId))
                .catch(() =>
                  dbLogger.error("cos inside history governance could not be scheduled", {
                    actorUserId: entry.actorUserId,
                    targetChatId: entry.targetChatId,
                    tgMessageId: entry.tgMessageId,
                  }),
                );
            },
            onFailure: async (entry: CosInsideHistoryFailure) => {
              await dbLogger.error("cos inside relay history could not be persisted", entry);
            },
          }
        : undefined;
    const cosInside =
      cosInsideTargets.length > 0
        ? {
            targets: cosInsideTargets,
            ...(cosInsideHistory ? { history: cosInsideHistory } : {}),
            onAudit: async (entry: CosInsideAuditEntry) => {
              try {
                await this.db.insert(miniAppAuditEvents).values({
                  botId,
                  actorTelegramUserId: entry.actorUserId,
                  actorRole: "admin",
                  capability: "message.relay",
                  action: "cos_inside.relay",
                  resourceType: "telegram_chat",
                  resourceId: String(entry.targetChatId),
                  nextSummary: {
                    alias: entry.alias,
                    bodyLength: entry.bodyLength,
                    hasReplyTarget: entry.hasReplyTarget,
                    ...(entry.failureReason ? { failureReason: entry.failureReason } : {}),
                  },
                  outcome: entry.outcome,
                });
              } catch (error) {
                // The relay already happened, so this line is the only remaining trace.
                dbLogger.error("cos inside relay audit could not be persisted", {
                  actorUserId: entry.actorUserId,
                  targetChatId: entry.targetChatId,
                  alias: entry.alias,
                  bodyLength: entry.bodyLength,
                  outcome: entry.outcome,
                  error: error instanceof Error ? error.message : String(error),
                });
              }
            },
          }
        : undefined;

    const manager = new BotManager({
      botId,
      token,
      adminChatIds: bot.adminChatIds,
      logger: this.logger,
      dbLogger,
      aiReply,
      aiSelectionCallbacks,
      conversation,
      privacy,
      onRestart: () => this.restartBot(botId),
      onBackup,
      onTokenUsage,
      onGenerationTrack,
      timerCallbacks,
      mcpCallbacks,
      summary: summaryCallbacks,
      imageGenerationReceiptConfig: aiConfig?.imageGenerationReceiptConfig,
      harness: this.harnessService?.claimBot({
        id: botId,
        name: bot.name,
        miniApp: miniAppUrl !== undefined,
      }),
      quota: this.usageGovernance
        ? {
            getUsage: async ({ chatId, userId, chatType }) => {
              const snapshot = await this.usageGovernance!.getSnapshot({
                botId,
                chatKind: chatType === "private" ? "private" : "group",
                chatId,
                userId,
                resources: ["ai_reply", "image"],
              });
              return {
                timezone: snapshot.timezone,
                resources: snapshot.resources.map((resource) => ({
                  label: usageSnapshotLabel(resource.resource, resource.scope),
                  windows: resource.windows.map((window) => ({
                    label: usageWindowLabel(window.window),
                    used: window.used,
                    limit: window.limit,
                    resetsAt: window.resetsAt?.toISOString(),
                  })),
                  active: resource.active,
                  concurrencyLimit: resource.concurrencyLimit,
                })),
              };
            },
            tighten: async (input) => {
              const authorized =
                bot.adminChatIds.includes(input.actorUserId) ||
                (await this.isDelegatedGroupAdmin(botId, input.chatId, input.actorUserId));
              if (!authorized) {
                return { ok: false, message: "需要 Bot 管理员授权且当前仍是 Telegram 群管理员。" };
              }
              if (!this.usageGovernance?.tightenGroupPolicy) {
                return { ok: false, message: "用量治理服务不可用。" };
              }
              try {
                await this.usageGovernance.tightenGroupPolicy({
                  botId,
                  chatId: input.chatId,
                  actorUserId: input.actorUserId,
                  resource: input.resource,
                  targetUserId: input.targetUserId,
                  limits: {
                    hour: input.hourly,
                    day: input.daily,
                    cooldownMs:
                      input.cooldownSeconds === undefined
                        ? undefined
                        : input.cooldownSeconds * 1_000,
                  },
                });
                return { ok: true };
              } catch {
                return { ok: false, message: "新设置只能比现有上限更严格，且只能作用于当前群聊。" };
              }
            },
          }
        : undefined,
      telegramObservation: this.telegramObservation,
      miniAppUrl,
      cosInside,
    });

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
    if (embeddingService) this.memoryEmbeddingServices.set(botId, embeddingService);
    if (this.chatAiSelectionService && aiReply) {
      try {
        const published = await this.chatAiSelectionService.retryPublish(botId);
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
    if (this.telegramProfileObserver) {
      try {
        const profile = await manager.getTelegramProfile();
        await this.telegramProfileObserver(botId, profile);
      } catch (err) {
        this.logger.warn({ err, botId }, "Failed to observe Telegram bot profile");
      }
    }
    void runInitialHistoryGovernance?.().catch((err) => {
      void dbLogger.error(
        `Initial conversation history governance failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    });
  }

  private async persistTerminalGeneration(
    botId: string,
    record: PixAIGenerationRecord,
    downloadImages = downloadGenerationImages,
    cleanupImages = cleanupGenerationImages,
  ): Promise<void> {
    const completedAt = new Date();
    let claimedGenerationId: number | undefined;
    await persistTerminalGenerationClaim(
      record.taskId,
      async () => {
        const [updated] = await this.db
          .update(pixaiGenerations)
          .set({
            status: record.status,
            mediaUrls: record.mediaUrls,
            mediaIds: record.mediaIds,
            nsfwScores: record.nsfwScores,
            errorMessage: record.errorMessage,
            durationMs: record.durationMs,
            completedAt,
          })
          .where(
            and(
              eq(pixaiGenerations.botId, botId),
              eq(pixaiGenerations.taskId, record.taskId),
              eq(pixaiGenerations.status, "pending"),
            ),
          )
          .returning({ id: pixaiGenerations.id });

        if (!updated) return false;
        claimedGenerationId = updated.id;
        this.generationInsertFallbacks.clear(botId, record.taskId);
        return true;
      },
      () =>
        this.generationInsertFallbacks.insertIfClaimed(
          botId,
          record.taskId,
          async () => {
            const [existing] = await this.db
              .select({ id: pixaiGenerations.id })
              .from(pixaiGenerations)
              .where(
                and(eq(pixaiGenerations.botId, botId), eq(pixaiGenerations.taskId, record.taskId)),
              );
            return existing === undefined;
          },
          async () => {
            const [inserted] = await this.db
              .insert(pixaiGenerations)
              .values({
                botId,
                chatId: record.chatId,
                userId: record.userId,
                taskId: record.taskId,
                prompt: record.prompt,
                negativePrompt: record.negativePrompt,
                modelId: record.modelId,
                width: record.width,
                height: record.height,
                batchSize: record.batchSize,
                samplingSteps: record.samplingSteps,
                cfgScale: record.cfgScale,
                promptHelper: record.promptHelper,
                pixaiConfig: record.pixaiConfig,
                status: record.status,
                mediaUrls: record.mediaUrls,
                mediaIds: record.mediaIds,
                nsfwScores: record.nsfwScores,
                errorMessage: record.errorMessage,
                durationMs: record.durationMs,
                completedAt,
              })
              .returning({ id: pixaiGenerations.id });
            if (!inserted) throw new Error(`Failed to insert PixAI generation ${record.taskId}`);
            claimedGenerationId = inserted.id;
          },
        ),
    );

    if (record.status !== "completed" || !record.mediaUrls?.length) return;
    if (claimedGenerationId === undefined) {
      throw new Error(`PixAI generation ${record.taskId} claim did not return an id`);
    }

    let localFiles: string[];
    try {
      localFiles = await downloadImages(botId, record.taskId, record.mediaUrls, this.logger);
    } catch (err) {
      this.logger.warn({ err, botId, taskId: record.taskId }, "PixAI image download failed");
      return;
    }
    if (localFiles.length === 0) return;

    try {
      const updated = await this.db
        .update(pixaiGenerations)
        .set({ localFiles })
        .where(eq(pixaiGenerations.id, claimedGenerationId))
        .returning({ id: pixaiGenerations.id });
      if (updated.length === 0) {
        await cleanupImages(botId, localFiles, this.logger);
      }
    } catch (err) {
      this.logger.warn(
        { err, botId, taskId: record.taskId },
        "Failed to persist PixAI local files; keeping files because commit outcome is unknown",
      );
    }
  }

  private async startLarkWebhookBot(botId: string, bot: typeof bots.$inferSelect) {
    const dbLogger = new DbLogger(this.db, this.logger, botId);

    const larkConfig = bot.larkWebhookConfig;
    if (!larkConfig?.webhookUrl) {
      throw new Error("Lark webhook URL is not configured");
    }

    const signSecret = larkConfig.encryptedSignSecret
      ? tryDecrypt(larkConfig.encryptedSignSecret, env.ENCRYPTION_KEY)
      : undefined;
    const larkClient = new LarkWebhookClient(larkConfig.webhookUrl, signSecret ?? undefined);

    // Build email monitor if configured
    let emailMonitor: ImapEmailMonitor | undefined;
    const emailConfig = bot.emailForwardConfig;

    if (emailConfig) {
      const password = tryDecrypt(emailConfig.encryptedPassword, env.ENCRYPTION_KEY);
      if (password) {
        emailMonitor = new ImapEmailMonitor(
          {
            host: emailConfig.imapHost,
            port: emailConfig.imapPort,
            secure: emailConfig.imapTls,
            auth: { user: emailConfig.email, pass: password },
            pollIntervalSec: emailConfig.pollIntervalSec,
            filters: emailConfig.filters,
            disabledEventTypes: emailConfig.disabledEventTypes,
          },
          larkClient,
          this.logger,
          emailConfig.larkMentionMap,
        );
      } else {
        dbLogger.warn("Cannot decrypt email password, email forwarding disabled").catch(() => {});
      }
    }

    const manager = new LarkBotManager({
      botId,
      dbLogger,
      larkClient,
      emailMonitor,
    });

    this.managers.set(botId, manager);
    await manager.start();
  }

  async stopBot(botId: string) {
    return this.enqueue(botId, () => this.stopBotImpl(botId));
  }

  private async stopBotImpl(botId: string) {
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
        this.managers.delete(botId);
        this.memoryEmbeddingServices.delete(botId);
        this.botTimerHandlers.delete(botId);
        this.aiSelectionRuntimeDisposers.get(botId)?.();
        this.aiSelectionRuntimeDisposers.delete(botId);
      }
    }
  }

  async restartBot(botId: string) {
    return this.enqueue(botId, async () => {
      const [bot] = await this.db
        .select({ isActive: bots.isActive })
        .from(bots)
        .where(eq(bots.id, botId));
      if (!bot) throw new Error(`Bot ${botId} not found`);
      if (!bot.isActive) {
        await this.stopBotImpl(botId);
        throw new Error(`Bot ${botId} is disabled`);
      }
      await this.stopBotImpl(botId);
      await this.startBotImpl(botId);
    });
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
    if (timer?.botId) {
      this.botTimerHandlers.get(timer.botId)?.cancelPendingTimer(timerId);
    }
    return this.timerRegistry.cancel(timerId);
  }

  getActiveTimersForBot(botId: string) {
    return this.timerRegistry.listActive({ botId });
  }

  /** Cancel only when the timer belongs to the requesting Bot. */
  async cancelTimerForBot(botId: string, timerId: string): Promise<boolean> {
    const timer = this.timerRegistry.get(timerId);
    if (!timer || timer.botId !== botId) return false;
    this.botTimerHandlers.get(botId)?.cancelPendingTimer(timerId);
    return this.timerRegistry.cancel(timerId);
  }

  private buildRssCallbacks(botId: string) {
    const rss = this.rssFeedService!;
    const requireCollection = async (collectionId: number, signal?: AbortSignal) => {
      signal?.throwIfAborted();
      const collection = await rss.getCollection(collectionId);
      if (!collection || collection.botId !== botId) throw new Error("Collection not found");
      signal?.throwIfAborted();
      return collection;
    };
    return {
      onListCollections: () => rss.listCollections(botId),
      onGetNewItems: async (collectionId: number, limit?: number) => {
        const collection = await requireCollection(collectionId);
        const { items, totalCount } = await rss.getUndigestedItems(collectionId, limit);
        return { collection, items, totalCount };
      },
      onListFeeds: async (collectionId: number) => {
        await requireCollection(collectionId);
        return rss.listFeeds(collectionId);
      },
      onMarkDigested: async (collectionId: number, signal?: AbortSignal) => {
        await requireCollection(collectionId, signal);
        signal?.throwIfAborted();
        await rss.markDigested(collectionId, signal);
      },
      onAddFeed: async (collectionId: number, feedUrl: string, signal?: AbortSignal) => {
        await requireCollection(collectionId, signal);
        signal?.throwIfAborted();
        return rss.addFeed(collectionId, feedUrl, undefined, undefined, signal);
      },
      onRemoveFeed: async (feedId: number, signal?: AbortSignal) => {
        signal?.throwIfAborted();
        const feed = await rss.getFeed(feedId);
        if (!feed) throw new Error(`Feed ${feedId} not found`);
        await requireCollection(feed.collectionId, signal);
        signal?.throwIfAborted();
        const ok = await rss.removeFeed(feedId, feed.collectionId, signal);
        if (!ok) throw new Error(`Feed ${feedId} not found`);
      },
      onCreateCollection: async (
        params: {
          name: string;
          chatId: number;
          description?: string;
          digestHour?: number;
          digestMinute?: number;
        },
        signal?: AbortSignal,
      ) => {
        signal?.throwIfAborted();
        return rss.createCollection({ botId, ...params }, signal);
      },
    };
  }

  private buildMcpToolsConfig(mcpServerIds?: number[]) {
    if (!this.mcpClientManager || !mcpServerIds?.length) return undefined;

    const mgr = this.mcpClientManager;
    return {
      getTools: () => mgr.getToolsForServers(mcpServerIds),
      callTool: (serverId: number, toolName: string, args: unknown) =>
        mgr.callTool(serverId, toolName, args),
    };
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

function guessExtension(url: string): string {
  try {
    const pathname = new URL(url).pathname;
    const ext = path.extname(pathname).toLowerCase();
    if (IMAGE_EXTENSIONS.has(ext)) return ext;
  } catch {
    // ignore
  }
  return ".png";
}

async function downloadGenerationImages(
  botId: string,
  taskId: string,
  urls: string[],
  logger: Logger,
): Promise<string[]> {
  const dir = path.join(getDataDir(botId), "generations");
  await mkdir(dir, { recursive: true });
  const results = await Promise.all(
    urls.map(async (url, i) => {
      const ext = guessExtension(url);
      const filename = `${taskId}_${i}${ext}`;
      try {
        const res = await fetch(url, {
          signal: AbortSignal.timeout(GENERATION_IMAGE_DOWNLOAD_TIMEOUT_MS),
        });
        if (!res.ok) {
          logger.warn({ taskId, index: i, status: res.status }, "PixAI image download failed");
          return null;
        }
        const buffer = Buffer.from(await res.arrayBuffer());
        await writeFile(path.join(dir, filename), buffer);
        return filename;
      } catch (err) {
        logger.warn(err, `PixAI image download error: task=${taskId} index=${i}`);
        return null;
      }
    }),
  );
  return results.filter((f): f is string => f != null);
}

async function cleanupGenerationImages(
  botId: string,
  localFiles: string[],
  logger: Logger,
): Promise<void> {
  const dir = path.join(getDataDir(botId), "generations");
  await Promise.all(
    localFiles.map(async (filename) => {
      try {
        await unlink(path.join(dir, filename));
      } catch (err) {
        logger.warn(err, `PixAI image cleanup error: file=${filename}`);
      }
    }),
  );
}
