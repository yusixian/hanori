import { mkdir, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import type { AiReplyBotConfig, BotTimerHandlers } from "@cos-tool-bot/bot";
import { NsfwChecker } from "@cos-tool-bot/bot";
import { escapeHtml } from "@cos-tool-bot/bot/utils/format";
import type { Database } from "@cos-tool-bot/database";
import {
  EMBEDDING_DIMENSIONS,
  bots,
  mcpServers,
  pixaiGenerations,
  tokenUsage,
} from "@cos-tool-bot/database";
import type {
  BotMemoryCallbacks,
  BotPlatform,
  ConversationCallbacks,
  IBotManager,
  MemoryCallbacks,
  ModelEntry,
  PixAIConfig,
  PixAIGenerationRecord,
  TelegramRichMessageFormat,
  TelegramRichMessageReceipt,
  TelegramRichMessageSender,
  TokenUsageRecord,
} from "@cos-tool-bot/shared";
import {
  DEFAULT_CONVERSATION_CONFIG,
  DEFAULT_MEMORY_CONFIG,
  DEFAULT_MESSAGE_CONFIG,
  IMAGE_EXTENSIONS,
  getDataDir,
} from "@cos-tool-bot/shared";
import { and, asc, eq, lte } from "drizzle-orm";
import type { Logger } from "pino";
import { createDataFilesLoader } from "../utils/data-files-loader.js";
import { env } from "../env.js";
import { tryDecrypt } from "../utils/crypto.js";
import { migrateAiConfig } from "../utils/ai-config-migrate.js";
import type { BackupService } from "./backup.js";
import { BotManager } from "./bot-manager.js";
import { BotMemoryStore } from "./bot-memory-store.js";
import { ChatModelStore } from "./chat-model-store.js";
import { ChatProviderStore } from "./chat-provider-store.js";
import { compressConversation } from "./conversation-compressor.js";
import { ConversationHistoryGovernor } from "./conversation-history-governor.js";
import { ConversationStore } from "./conversation-store.js";
import { DbLogger } from "./db-logger.js";
import { EmbeddingService } from "./embedding-service.js";
import { ImapEmailMonitor } from "./imap-email-monitor.js";
import {
  AsyncTaskLimiter,
  confirmPendingInsertAbsent,
  isTerminalGenerationRecoveryError,
  PendingGenerationInsertFallbackTracker,
  persistTerminalGenerationClaim,
  resolvePixaiTaskTimeoutMs,
  tryPersistTerminalGenerationFailure,
} from "./generation-recovery.js";
import { LarkBotManager } from "./lark-bot-manager.js";
import { LarkWebhookClient } from "./lark-webhook-client.js";
import { KeyedAsyncLock } from "./keyed-async-lock.js";
import { PeopleProfileStore, mapProfileToDto } from "./people-profile-store.js";
import { selectMemoriesForPrompt } from "./prompt-memory-selector.js";
import type { McpClientManager } from "./mcp-client-manager.js";
import type { RssFeedService } from "./rss-feed-service.js";
import type { TimerRegistry } from "./timer-registry.js";
import type { ChatSummaryService } from "./chat-summary-service.js";
import type { SummaryConfigService } from "./summary-config-service.js";
import {
  BotNotRunningError,
  TelegramRichMessagesUnsupportedError,
} from "./telegram-rich-message-errors.js";

const CONVERSATION_CLEANUP_INTERVAL_MS = 60 * 60 * 1000;
const CONVERSATION_GOVERNANCE_STARTUP_GRACE_MS = 15_000;
const GENERATION_RECOVERY_CONCURRENCY = 3;
const GENERATION_RECOVERY_BATCH_SIZE = GENERATION_RECOVERY_CONCURRENCY;
const GENERATION_RECOVERY_SWEEP_INTERVAL_MS = 60_000;
const GENERATION_IMAGE_DOWNLOAD_TIMEOUT_MS = 30_000;

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
  private botMemoryStore: BotMemoryStore;
  private chatModelStore: ChatModelStore;
  private chatProviderStore: ChatProviderStore;
  private backupService?: BackupService;
  private rssFeedService?: RssFeedService;
  private mcpClientManager?: McpClientManager;
  private timerRegistry: TimerRegistry;
  private summaryService?: ChatSummaryService;
  private summaryConfigService?: SummaryConfigService;

  constructor(
    private db: Database,
    private logger: Logger,
    timerRegistry: TimerRegistry,
  ) {
    this.timerRegistry = timerRegistry;
    this.conversationStore = new ConversationStore(db);
    this.profileStore = new PeopleProfileStore(db);
    this.botMemoryStore = new BotMemoryStore(db);
    this.chatModelStore = new ChatModelStore(db);
    this.chatProviderStore = new ChatProviderStore(db);
  }

  setBackupService(service: BackupService) {
    this.backupService = service;
  }

  setMcpClientManager(manager: McpClientManager) {
    this.mcpClientManager = manager;
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

  async startBot(botId: string) {
    return this.enqueue(botId, () => this.startBotImpl(botId));
  }

  private async startBotImpl(botId: string) {
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

    const [bot] = await this.db.select().from(bots).where(eq(bots.id, botId));
    if (!bot) throw new Error(`Bot ${botId} not found`);

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
    const dbLogger = new DbLogger(this.db, this.logger, botId);

    // Build AI reply config if configured
    let aiReply: AiReplyBotConfig | undefined;
    let conversation: ConversationCallbacks | undefined;
    let runInitialHistoryGovernance: (() => Promise<void>) | undefined;
    const aiConfig = bot.aiConfig ? migrateAiConfig(bot.aiConfig) : null;
    const pixaiTaskTimeoutMs = resolvePixaiTaskTimeoutMs(aiConfig?.timeoutConfig?.pixaiTaskMs);
    const runtimeTimeoutConfig = aiConfig?.timeoutConfig
      ? { ...aiConfig.timeoutConfig, pixaiTaskMs: pixaiTaskTimeoutMs }
      : undefined;
    // Decrypt all providers up front — kept in-memory for bot lifetime.
    // Track skip reasons separately so operators can distinguish "no key configured"
    // from "encryption key mismatch" when diagnosing.
    const providersRuntime: Array<{
      id: string;
      label: string;
      apiKey: string;
      baseURL: string;
      providerFormat: "openai" | "gemini";
      defaultModel: string;
      models?: ModelEntry[];
    }> = [];
    const skippedNoKey: string[] = [];
    const skippedDecryptFail: string[] = [];
    for (const p of aiConfig?.providers ?? []) {
      if (!p.encryptedApiKey) {
        skippedNoKey.push(p.label);
        continue;
      }
      const decrypted = tryDecrypt(p.encryptedApiKey, env.ENCRYPTION_KEY);
      if (!decrypted) {
        skippedDecryptFail.push(p.label);
        continue;
      }
      providersRuntime.push({
        id: p.id,
        label: p.label,
        apiKey: decrypted,
        baseURL: p.baseURL,
        providerFormat: p.providerFormat,
        defaultModel: p.defaultModel,
        models: p.models,
      });
    }
    const activeProvider =
      (aiConfig?.activeProviderId &&
        providersRuntime.find((p) => p.id === aiConfig.activeProviderId)) ||
      providersRuntime[0];
    if (aiConfig?.enabled && activeProvider) {
      const apiKey = activeProvider.apiKey;
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
              apiKey: activeProvider.apiKey,
              baseURL: activeProvider.baseURL,
              model: activeProvider.defaultModel,
              providerFormat: activeProvider.providerFormat,
              logger: this.logger,
            }),
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
      let embeddingService: EmbeddingService | undefined;
      const embeddingCfg = aiConfig.embeddingConfig;
      if (embeddingCfg?.enabled && embeddingCfg.encryptedApiKey) {
        const embeddingApiKey = tryDecrypt(embeddingCfg.encryptedApiKey, env.ENCRYPTION_KEY);
        if (embeddingApiKey) {
          embeddingService = new EmbeddingService(
            {
              apiKey: embeddingApiKey,
              baseURL: embeddingCfg.baseURL,
              model: embeddingCfg.model,
              dimensions: EMBEDDING_DIMENSIONS,
            },
            this.logger,
          );
        } else {
          dbLogger.warn(
            "Encryption key mismatch: cannot decrypt embedding API key. Embedding features disabled.",
          );
        }
      }

      conversation = {
        getHistory: (chatId, limit) => store.getHistory(botId, chatId, limit),
        addMessage: (p) => store.addMessage({ botId, ...p }),
        addMessages: async (msgs) => {
          const persisted = await store.addMessages(msgs.map((m) => ({ botId, ...m })));
          // Fire-and-forget: async generate embeddings (non-blocking)
          if (embeddingService && persisted.length > 0) {
            const toEmbed = persisted.filter(
              (message) =>
                message.content.length > 0 &&
                (message.role === "user" || message.role === "assistant"),
            );
            if (toEmbed.length > 0) {
              embeddingService
                .generateEmbeddings(toEmbed.map((message) => message.content))
                .then((embeddings) => {
                  for (let i = 0; i < embeddings.length; i++) {
                    const emb = embeddings[i];
                    if (emb) {
                      store.updateEmbedding(toEmbed[i]!.id, emb).catch((err) => {
                        this.logger.warn(err, "Failed to persist message embedding");
                      });
                    }
                  }
                })
                .catch((err) => {
                  this.logger.warn(err, "Batch message embedding generation failed");
                });
            }
          }
        },
        triggerCompression: (chatId) => {
          this.triggerConversationCleanup(botId, conversationCfg.retentionDays);
          governChat(chatId).catch((err) => {
            void dbLogger.error(
              `Conversation history governance failed for chat=${chatId}: ${err instanceof Error ? err.message : String(err)}`,
              { chatId },
            );
          });
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
          upsertProfile: (data) => ps.upsertProfile(botId, data).then(mapProfileToDto),
          searchProfiles: (query) =>
            ps.searchProfiles(botId, query).then((profiles) => profiles.map(mapProfileToDto)),
          searchHistory: async (params) => {
            let queryEmbedding: number[] | undefined;
            if (embeddingService && params.query) {
              const emb = await embeddingService.generateEmbedding(params.query);
              if (emb) queryEmbedding = emb;
            }
            return cs.searchMessages(botId, { ...params, queryEmbedding });
          },
          touchProfile: (observation) => ps.touchProfile(botId, observation),
        };
      }

      // Build bot memory callbacks (independent of people profile memory)
      const botMemoryCfg = aiConfig.botMemoryConfig;
      let botMemory: BotMemoryCallbacks | undefined;
      if (botMemoryCfg?.enabled) {
        const ms = this.botMemoryStore;
        const es = embeddingService;

        // Dedup threshold constants
        const DEDUP_EXACT = 0.05; // cosine distance < 0.05 → duplicate (similarity > 0.95)
        const DEDUP_SIMILAR = 0.15; // cosine distance < 0.15 → similar (similarity > 0.85)

        botMemory = {
          saveMemory: async (params) => {
            // Sync embedding generation for bot memories (for dedup)
            let embedding: number[] | undefined;
            if (es) {
              const emb = await es.generateEmbedding(params.content);
              if (emb) {
                embedding = emb;
                // Dedup check (scoped by telegramId)
                const similar = await ms.findSimilar(botId, emb, DEDUP_SIMILAR, {
                  telegramId: params.telegramId,
                });
                const exact = similar.find((s) => s.distance < DEDUP_EXACT);
                if (exact) {
                  // Near-duplicate: just touch updatedAt
                  await ms.touchMemory(exact.id);
                  return exact;
                }
              }
            }
            return ms.saveMemory(botId, { ...params, embedding });
          },
          recallMemories: async (params) => {
            let queryEmbedding: number[] | undefined;
            if (es && params.query) {
              const emb = await es.generateEmbedding(params.query);
              if (emb) queryEmbedding = emb;
            }
            return ms.recallMemories(botId, { ...params, queryEmbedding });
          },
          deleteMemory: (memoryId) => ms.deleteMemory(botId, memoryId),
          getMemoriesForPrompt: (telegramId, limit) =>
            ms.getMemoriesForPrompt(botId, {
              telegramId,
              limit: limit ?? botMemoryCfg.maxMemories,
            }),
          getMemoriesForQuery: (params) =>
            selectMemoriesForPrompt({
              botId,
              query: params.query,
              telegramId: params.telegramId,
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

      // Load persisted per-chat model + provider overrides
      const chatModelMap = await this.chatModelStore.loadOverrides(botId);
      const chatModelStoreRef = this.chatModelStore;
      const chatProviderMap = await this.chatProviderStore.loadOverrides(botId);
      const chatProviderStoreRef = this.chatProviderStore;
      // Purge stale overrides whose provider was deleted since last load
      await chatProviderStoreRef.purgeInvalid(
        botId,
        providersRuntime.map((p) => p.id),
      );
      for (const [chatId, pid] of chatProviderMap) {
        if (!providersRuntime.some((p) => p.id === pid)) chatProviderMap.delete(chatId);
      }

      // Build data files config for prompt injection and file tools
      const dataFilesConfig = aiConfig.dataFilesConfig;
      const dataFiles = await createDataFilesLoader(botId, {
        injectableFiles: dataFilesConfig?.injectableFiles,
        maxTotalSize: dataFilesConfig?.maxTotalSize,
      });

      let nsfwChecker: NsfwChecker | undefined;
      if (env.NSFW_API_URL) {
        const threshold = aiConfig.webToolsConfig?.imageGeneration?.pixaiConfig?.nsfwThreshold;
        nsfwChecker = new NsfwChecker({
          apiUrl: env.NSFW_API_URL,
          threshold,
          logger: (level, message, meta) => {
            this.logger[level]({ ...meta }, `[NsfwChecker] ${message}`);
          },
        });
      }

      aiReply = {
        botId,
        apiKey,
        baseURL: activeProvider.baseURL,
        model: activeProvider.defaultModel,
        providerFormat: activeProvider.providerFormat,
        providers: providersRuntime,
        activeProviderId: activeProvider.id,
        providerOverride: {
          getProviderForChat: (chatId) => chatProviderMap.get(chatId),
          setProviderForChat: (chatId, providerId) => {
            chatProviderMap.set(chatId, providerId);
            chatProviderStoreRef.setOverride(botId, chatId, providerId).catch(() => {});
          },
          resetProviderForChat: (chatId) => {
            chatProviderMap.delete(chatId);
            chatProviderStoreRef.removeOverride(botId, chatId).catch(() => {});
          },
        },
        systemPrompt: aiConfig.systemPrompt,
        behavioralPrompt: aiConfig.behavioralPrompt,
        groupBehavioralPrompt: aiConfig.groupBehavioralPrompt,
        triggerConfig: aiConfig.triggerConfig,
        groupOverrides: aiConfig.groupOverrides,
        conversationConfig: conversationCfg,
        conversation,
        memoryConfig: memoryCfg,
        memory,
        stickerPacks: aiConfig.stickerPacks,
        webToolsConfig: aiConfig.webToolsConfig,
        agentToolsConfig: aiConfig.agentToolsConfig,
        artworkToolsConfig: aiConfig.artworkToolsConfig,
        botMemoryConfig: botMemoryCfg,
        botMemory,
        messageConfig: aiConfig.messageConfig,
        imageOcrConfig: aiConfig.imageOcrConfig,
        timeoutConfig: runtimeTimeoutConfig,
        models: activeProvider.models ?? aiConfig.models,
        modelCommandAccess: aiConfig.modelCommandAccess,
        modelOverride: {
          getModelForChat: (chatId) => chatModelMap.get(chatId),
          setModelForChat: (chatId, modelId) => {
            chatModelMap.set(chatId, modelId);
            chatModelStoreRef.setOverride(botId, chatId, modelId).catch(() => {});
          },
          resetModelForChat: (chatId) => {
            chatModelMap.delete(chatId);
            chatModelStoreRef.removeOverride(botId, chatId).catch(() => {});
          },
        },
        dataFiles,
        privateChatWhitelist: aiConfig.privateChatWhitelist,
        nsfwChecker,
        onGroupOverrideUpdate: async (chatId, override) => {
          try {
            await this.withAiConfigLock(botId, () =>
              this.db.transaction(async (tx) => {
                const [current] = await tx.select().from(bots).where(eq(bots.id, botId));
                if (!current?.aiConfig) return;
                await tx
                  .update(bots)
                  .set({
                    aiConfig: {
                      ...current.aiConfig,
                      groupOverrides: {
                        ...current.aiConfig.groupOverrides,
                        [String(chatId)]: override,
                      },
                    },
                  })
                  .where(eq(bots.id, botId));
              }),
            );
          } catch (err) {
            this.logger.error(err, "Failed to persist group override update");
          }
        },
        onPixaiConfigUpdate: async (updates) => {
          try {
            await this.withAiConfigLock(botId, () =>
              this.db.transaction(async (tx) => {
                const [current] = await tx.select().from(bots).where(eq(bots.id, botId));
                if (!current?.aiConfig) return;
                const imgGen = current.aiConfig.webToolsConfig?.imageGeneration;
                if (!imgGen) return;
                if (updates.model !== undefined) imgGen.model = updates.model;
                if (updates.pixaiConfig) {
                  imgGen.pixaiConfig = { ...imgGen.pixaiConfig, ...updates.pixaiConfig };
                }
                await tx
                  .update(bots)
                  .set({ aiConfig: { ...current.aiConfig } })
                  .where(eq(bots.id, botId));
              }),
            );
          } catch (err) {
            this.logger.error(err, "Failed to persist pixai config update");
          }
        },
        onMessageConfigUpdate: async (updates) => {
          try {
            await this.withAiConfigLock(botId, () =>
              this.db.transaction(async (tx) => {
                const [current] = await tx.select().from(bots).where(eq(bots.id, botId));
                if (!current?.aiConfig) throw new Error("AI is not configured");
                await tx
                  .update(bots)
                  .set({
                    aiConfig: {
                      ...current.aiConfig,
                      messageConfig: {
                        ...DEFAULT_MESSAGE_CONFIG,
                        ...current.aiConfig.messageConfig,
                        ...updates,
                      },
                    },
                  })
                  .where(eq(bots.id, botId));
              }),
            );
          } catch (error) {
            this.logger.error(error, "Failed to persist message config update");
            throw error;
          }
        },
        onWebToolApiKeyUpdate: async (target, apiKey) => {
          let shouldRecoverPending = false;
          await this.withAiConfigLock(botId, () =>
            this.db.transaction(async (tx) => {
              const [current] = await tx.select().from(bots).where(eq(bots.id, botId));
              const webToolsConfig = current?.aiConfig?.webToolsConfig;
              if (!current?.aiConfig || !webToolsConfig) {
                throw new Error("Web tools are not configured");
              }

              const targetConfig =
                target === "image" ? webToolsConfig.imageGeneration : webToolsConfig.search;
              if (!targetConfig) {
                throw new Error(`${target} web tool is not configured`);
              }

              targetConfig.apiKey = apiKey;
              shouldRecoverPending =
                target === "image" && webToolsConfig.imageGeneration?.provider === "pixai";
              await tx
                .update(bots)
                .set({ aiConfig: { ...current.aiConfig, webToolsConfig: { ...webToolsConfig } } })
                .where(eq(bots.id, botId));
            }),
          );

          if (shouldRecoverPending) {
            const preexistingPendingCutoff = new Date();
            await this.cancelGenerationRecoveries(botId, "PixAI API key updated");
            const currentManager = this.managers.get(botId);
            if (currentManager instanceof BotManager) {
              const timeoutMs = pixaiTaskTimeoutMs;
              this.generationRecoveryConfigs.set(botId, {
                manager: currentManager,
                apiKey,
                timeoutMs,
                preexistingPendingCutoff,
              });
              this.startGenerationRecoveryScheduler();
              void this.schedulePendingGenerationRecovery(
                botId,
                currentManager,
                apiKey,
                timeoutMs,
                preexistingPendingCutoff,
              ).catch((err) => {
                this.logger.error(err, "Failed to schedule pending generation recovery");
              });
            }
          }
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
      onTimerCreate: (params: {
        timerId: string;
        chatId: number;
        seconds: number;
        reason: string;
      }) => {
        registry
          .registerAi({
            timerId: params.timerId,
            botId,
            chatId: params.chatId,
            name: params.reason,
            seconds: params.seconds,
            meta: { reason: params.reason },
          })
          .catch((err) => {
            this.logger.error(err, `Failed to register AI timer in registry`);
          });
      },
      onTimerCancel: (timerId: string) => {
        registry.cancel(timerId).catch((err) => {
          this.logger.error(err, `Failed to cancel timer ${timerId} in registry`);
        });
      },
      onTimerFired: (timerId: string) => {
        registry.markFired(timerId).catch((err) => {
          this.logger.error(err, `Failed to mark timer ${timerId} fired in registry`);
        });
      },
      onGetTimers: () => registry.listActive(),
      onCancelTimer: (timerId: string) => this.cancelTimer(timerId),
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
            triggerManual: (opts: Parameters<typeof this.summaryService.triggerManual>[0]) =>
              this.summaryService!.triggerManual(opts),
            getAccessMode: async (chatId: number) => {
              const cfg = await this.summaryConfigService!.getByChat(botId, chatId);
              return cfg?.accessMode ?? null;
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
      conversation,
      onRestart: () => this.restartBot(botId),
      onBackup,
      onTokenUsage,
      onGenerationTrack,
      timerCallbacks,
      mcpCallbacks,
      summary: summaryCallbacks,
    });

    const preexistingPendingCutoff = new Date();
    this.managers.set(botId, manager);
    await manager.start();
    if (manager.status !== "running") {
      this.managers.delete(botId);
      this.botTimerHandlers.delete(botId);
      throw new Error("Bot failed to start; check bot logs for details");
    }
    void runInitialHistoryGovernance?.().catch((err) => {
      void dbLogger.error(
        `Initial conversation history governance failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    });

    const imageGeneration = aiConfig?.webToolsConfig?.imageGeneration;
    if (imageGeneration?.provider === "pixai" && imageGeneration.apiKey) {
      const timeoutMs = pixaiTaskTimeoutMs;
      this.generationRecoveryConfigs.set(botId, {
        manager,
        apiKey: imageGeneration.apiKey,
        timeoutMs,
        preexistingPendingCutoff,
      });
      this.startGenerationRecoveryScheduler();
      void this.schedulePendingGenerationRecovery(
        botId,
        manager,
        imageGeneration.apiKey,
        timeoutMs,
        preexistingPendingCutoff,
      ).catch((err) => {
        this.logger.error(err, "Failed to schedule startup generation recovery");
      });
    }
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
    const manager = this.managers.get(botId);
    if (!manager) return;
    await manager.stop();
    this.managers.delete(botId);
    this.botTimerHandlers.delete(botId);
  }

  async restartBot(botId: string) {
    return this.enqueue(botId, async () => {
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

  private buildRssCallbacks(botId: string) {
    const rss = this.rssFeedService!;
    return {
      onListCollections: () => rss.listCollections(botId),
      onGetNewItems: async (collectionId: number, limit?: number) => {
        const [collection, { items, totalCount }] = await Promise.all([
          rss.getCollection(collectionId),
          rss.getUndigestedItems(collectionId, limit),
        ]);
        if (!collection) throw new Error("Collection not found");
        return { collection, items, totalCount };
      },
      onMarkDigested: (collectionId: number) => rss.markDigested(collectionId),
      onAddFeed: (collectionId: number, feedUrl: string) => rss.addFeed(collectionId, feedUrl),
      onRemoveFeed: async (feedId: number) => {
        const ok = await rss.removeFeed(feedId);
        if (!ok) throw new Error(`Feed ${feedId} not found`);
      },
      onCreateCollection: (params: {
        name: string;
        chatId: number;
        description?: string;
        digestHour?: number;
        digestMinute?: number;
      }) => rss.createCollection({ botId, ...params }),
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
  private fireRssDigest(botId: string, chatId: number, eventDescription: string): boolean {
    const handlers = this.botTimerHandlers.get(botId);
    if (handlers) {
      // Reuse fireTimer path — it calls continueChat with the event description
      handlers.fireTimer(chatId, `rss_digest_${Date.now()}`, eventDescription);
      this.logger.info({ botId, chatId }, "RSS digest triggered via continueChat");
      return true;
    }
    this.logger.warn({ botId, chatId }, "No handler for bot, RSS digest cannot trigger");
    return false;
  }

  /** Fire a recovered timer by triggering the bot's continueChat. */
  fireRecoveredTimer(
    timerId: string,
    botId: string,
    chatId: number,
    meta: Record<string, unknown> | null,
  ): void {
    const manager = this.managers.get(botId);
    if (!manager) {
      this.logger.warn(`Cannot fire recovered timer ${timerId}: bot ${botId} not managed`);
      return;
    }

    // Mark as fired in registry
    this.timerRegistry.markFired(timerId).catch((err) => {
      this.logger.error(err, `Failed to mark recovered timer ${timerId} as fired`);
    });

    // Fire via bot's continueChat
    const handlers = this.botTimerHandlers.get(botId);
    if (handlers) {
      const reason = (meta?.reason as string) ?? "Recovered timer";
      handlers.fireTimer(chatId, timerId, reason);
      this.logger.info({ timerId, botId, chatId }, "Recovered timer fired via bot continueChat");
    } else {
      this.logger.warn(
        { timerId, botId, chatId },
        "No fire handler for bot, recovered timer cannot trigger continueChat",
      );
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
