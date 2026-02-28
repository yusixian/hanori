import type { AiReplyBotConfig } from "@cos-tool-bot/bot";
import type { Database } from "@cos-tool-bot/database";
import { EMBEDDING_DIMENSIONS, bots } from "@cos-tool-bot/database";
import type {
  BotMemoryCallbacks,
  ConversationCallbacks,
  MemoryCallbacks,
} from "@cos-tool-bot/shared";
import { DEFAULT_CONVERSATION_CONFIG, DEFAULT_MEMORY_CONFIG } from "@cos-tool-bot/shared";
import { eq } from "drizzle-orm";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { Logger } from "pino";
import { getDataDir } from "../utils/file-validation.js";
import { env } from "../env.js";
import { tryDecrypt } from "../utils/crypto.js";
import type { BackupService } from "./backup.js";
import { BotManager } from "./bot-manager.js";
import { BotMemoryStore } from "./bot-memory-store.js";
import { ChatModelStore } from "./chat-model-store.js";
import { compressConversation } from "./conversation-compressor.js";
import { ConversationStore } from "./conversation-store.js";
import { DbLogger } from "./db-logger.js";
import { EmbeddingService } from "./embedding-service.js";
import { PeopleProfileStore } from "./people-profile-store.js";

export class BotPool {
  private managers = new Map<string, BotManager>();
  private conversationStore: ConversationStore;
  private profileStore: PeopleProfileStore;
  private botMemoryStore: BotMemoryStore;
  private chatModelStore: ChatModelStore;
  private backupService?: BackupService;

  constructor(
    private db: Database,
    private logger: Logger,
  ) {
    this.conversationStore = new ConversationStore(db);
    this.profileStore = new PeopleProfileStore(db);
    this.botMemoryStore = new BotMemoryStore(db);
    this.chatModelStore = new ChatModelStore(db);
  }

  setBackupService(service: BackupService) {
    this.backupService = service;
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

  async startAll() {
    let activeBots;
    try {
      activeBots = await this.db.select().from(bots).where(eq(bots.isActive, true));
    } catch (err) {
      this.logger.warn(err, "Failed to query active bots (table may not exist — run migrations)");
      return;
    }
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
    const ids = [...this.managers.keys()];
    for (const id of ids) {
      try {
        await this.stopBot(id);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        this.logger.error(err, `Failed to stop bot ${id}: ${msg}`);
      }
    }
  }

  async startBot(botId: string) {
    if (this.managers.has(botId)) {
      this.logger.warn(`Bot ${botId} is already managed, skipping`);
      return;
    }

    const [bot] = await this.db.select().from(bots).where(eq(bots.id, botId));
    if (!bot) throw new Error(`Bot ${botId} not found`);

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
    const aiConfig = bot.aiConfig;
    if (aiConfig?.enabled && aiConfig.encryptedApiKey) {
      const apiKey = tryDecrypt(aiConfig.encryptedApiKey, env.ENCRYPTION_KEY);
      if (!apiKey) {
        dbLogger.warn(
          "Encryption key mismatch: cannot decrypt AI API key. AI features disabled. Please update the API key in settings.",
        );
      } else {
        const conversationCfg = aiConfig.conversationConfig ?? DEFAULT_CONVERSATION_CONFIG;
        const store = this.conversationStore;

        // Create embedding service early so closures can reference it
        let embeddingService: EmbeddingService | undefined;
        const embeddingCfg = aiConfig.embeddingConfig;
        if (embeddingCfg?.enabled && embeddingCfg.encryptedApiKey) {
          const embeddingApiKey = tryDecrypt(embeddingCfg.encryptedApiKey, env.ENCRYPTION_KEY);
          if (embeddingApiKey) {
            if (embeddingCfg.dimensions !== EMBEDDING_DIMENSIONS) {
              dbLogger.warn(
                `Embedding dimensions mismatch: config=${embeddingCfg.dimensions} schema=${EMBEDDING_DIMENSIONS}. Using schema dimensions.`,
              );
            }
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
            const ids = await store.addMessages(msgs.map((m) => ({ botId, ...m })));
            // Fire-and-forget: async generate embeddings (non-blocking)
            if (embeddingService && ids.length > 0) {
              const toEmbed = msgs
                .map((m, i) => ({ msg: m, id: ids[i]! }))
                .filter(
                  ({ msg }) =>
                    msg.content.length > 0 && (msg.role === "user" || msg.role === "assistant"),
                );
              if (toEmbed.length > 0) {
                embeddingService
                  .generateEmbeddings(toEmbed.map((e) => e.msg.content))
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
            compressConversation({
              botId,
              chatId,
              store,
              conversationConfig: conversationCfg,
              apiKey,
              baseURL: aiConfig.baseURL,
              model: aiConfig.model,
              logger: this.logger,
            }).catch((err) => {
              this.logger.error(
                err,
                `Conversation compression failed for bot=${botId} chat=${chatId}`,
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
              ps.getProfile(botId, telegramId).then((p) =>
                p
                  ? {
                      telegramId: p.telegramId,
                      username: p.username,
                      displayName: p.displayName,
                      notes: p.notes,
                      traits: p.traits ?? [],
                      interests: p.interests ?? [],
                      relationship: p.relationship,
                      firstSeen: p.firstSeen.toISOString(),
                      lastSeen: p.lastSeen.toISOString(),
                    }
                  : null,
              ),
            upsertProfile: (data) =>
              ps.upsertProfile(botId, data).then((p) => ({
                telegramId: p.telegramId,
                username: p.username,
                displayName: p.displayName,
                notes: p.notes,
                traits: p.traits ?? [],
                interests: p.interests ?? [],
                relationship: p.relationship,
                firstSeen: p.firstSeen.toISOString(),
                lastSeen: p.lastSeen.toISOString(),
              })),
            searchProfiles: (query) =>
              ps.searchProfiles(botId, query).then((profiles) =>
                profiles.map((p) => ({
                  telegramId: p.telegramId,
                  username: p.username,
                  displayName: p.displayName,
                  notes: p.notes,
                  traits: p.traits ?? [],
                  interests: p.interests ?? [],
                  relationship: p.relationship,
                  firstSeen: p.firstSeen.toISOString(),
                  lastSeen: p.lastSeen.toISOString(),
                })),
              ),
            searchHistory: async (params) => {
              let queryEmbedding: number[] | undefined;
              if (embeddingService && params.query) {
                const emb = await embeddingService.generateEmbedding(params.query);
                if (emb) queryEmbedding = emb;
              }
              return cs.searchMessages(botId, { ...params, queryEmbedding });
            },
            touchProfile: (telegramId, displayName, username) =>
              ps.touchProfile(botId, telegramId, displayName, username),
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
              ms.getMemoriesForPrompt(botId, telegramId, limit ?? botMemoryCfg.maxMemories),
          };
        }

        // Load persisted per-chat model overrides
        const chatModelMap = await this.chatModelStore.loadOverrides(botId);
        const chatModelStoreRef = this.chatModelStore;

        // Build data files config for prompt injection and file tools
        const dataDir = getDataDir(botId);
        await fs.mkdir(dataDir, { recursive: true });
        const PRIORITY_FILES = ["IDENTITY.md", "SOUL.md"];
        const CACHE_TTL_MS = 30_000; // 30s
        let cachedFiles: Array<{ name: string; content: string }> | null = null;
        let cacheTime = 0;
        const dataFiles = {
          dataDir,
          loadFiles: async () => {
            const now = Date.now();
            if (cachedFiles && now - cacheTime < CACHE_TTL_MS) return cachedFiles;
            try {
              const entries = await fs.readdir(dataDir);
              // Only .md files are injected into the system prompt (identity/soul/notes).
              // Other formats (.txt/.json) are accessible via file tools but not auto-injected.
              const mdFiles = entries.filter((f) => f.endsWith(".md"));
              // Sort: priority files first, then alphabetical
              mdFiles.sort((a, b) => {
                const ai = PRIORITY_FILES.indexOf(a);
                const bi = PRIORITY_FILES.indexOf(b);
                if (ai >= 0 && bi >= 0) return ai - bi;
                if (ai >= 0) return -1;
                if (bi >= 0) return 1;
                return a.localeCompare(b);
              });
              const results: Array<{ name: string; content: string }> = [];
              for (const name of mdFiles) {
                const content = await fs.readFile(path.join(dataDir, name), "utf-8");
                if (content.trim()) results.push({ name, content });
              }
              cachedFiles = results;
              cacheTime = now;
              return results;
            } catch {
              return [];
            }
          },
        };

        aiReply = {
          apiKey,
          baseURL: aiConfig.baseURL,
          model: aiConfig.model,
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
          models: aiConfig.models,
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
        };
      }
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

    const manager = new BotManager({
      botId,
      token,
      adminChatIds: bot.adminChatIds,
      logger: this.logger,
      dbLogger,
      aiReply,
      conversation,
      onBackup,
    });

    this.managers.set(botId, manager);
    await manager.start();
  }

  async stopBot(botId: string) {
    const manager = this.managers.get(botId);
    if (!manager) return;
    await manager.stop();
    this.managers.delete(botId);
  }

  async restartBot(botId: string) {
    await this.stopBot(botId);
    await this.startBot(botId);
  }

  getManager(botId: string): BotManager | undefined {
    return this.managers.get(botId);
  }

  getAllManagers(): Map<string, BotManager> {
    return this.managers;
  }
}
