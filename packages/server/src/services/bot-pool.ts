import type { AiReplyBotConfig } from "@cos-tool-bot/bot";
import type { Database } from "@cos-tool-bot/database";
import { bots } from "@cos-tool-bot/database";
import type { ConversationCallbacks, MemoryCallbacks } from "@cos-tool-bot/shared";
import { DEFAULT_CONVERSATION_CONFIG, DEFAULT_MEMORY_CONFIG } from "@cos-tool-bot/shared";
import { eq } from "drizzle-orm";
import type { Logger } from "pino";
import { env } from "../env.js";
import { decrypt } from "../utils/crypto.js";
import { BotManager } from "./bot-manager.js";
import { compressConversation } from "./conversation-compressor.js";
import { ConversationStore } from "./conversation-store.js";
import { DbLogger } from "./db-logger.js";
import { PeopleProfileStore } from "./people-profile-store.js";

export class BotPool {
  private managers = new Map<string, BotManager>();
  private conversationStore: ConversationStore;
  private profileStore: PeopleProfileStore;

  constructor(
    private db: Database,
    private logger: Logger,
  ) {
    this.conversationStore = new ConversationStore(db);
    this.profileStore = new PeopleProfileStore(db);
  }

  getConversationStore(): ConversationStore {
    return this.conversationStore;
  }

  getProfileStore(): PeopleProfileStore {
    return this.profileStore;
  }

  async startAll() {
    let activeBots;
    try {
      activeBots = await this.db.select().from(bots).where(eq(bots.isActive, true));
    } catch (err) {
      this.logger.warn(err, "Failed to query active bots (table may not exist — run migrations)");
      return;
    }
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

    const token = decrypt(bot.encryptedToken, env.ENCRYPTION_KEY);
    const dbLogger = new DbLogger(this.db, this.logger, botId);

    // Build AI reply config if configured
    let aiReply: AiReplyBotConfig | undefined;
    let conversation: ConversationCallbacks | undefined;
    const aiConfig = bot.aiConfig;
    if (aiConfig?.enabled && aiConfig.encryptedApiKey) {
      const apiKey = decrypt(aiConfig.encryptedApiKey, env.ENCRYPTION_KEY);
      const conversationCfg = aiConfig.conversationConfig ?? DEFAULT_CONVERSATION_CONFIG;
      const store = this.conversationStore;

      conversation = {
        getHistory: (chatId, limit) => store.getHistory(botId, chatId, limit),
        addMessage: (p) => store.addMessage({ botId, ...p }),
        addMessages: (msgs) => store.addMessages(msgs.map((m) => ({ botId, ...m }))),
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
          searchHistory: (params) => cs.searchMessages(botId, params),
          touchProfile: (telegramId, displayName, username) =>
            ps.touchProfile(botId, telegramId, displayName, username),
        };
      }

      aiReply = {
        apiKey,
        baseURL: aiConfig.baseURL,
        model: aiConfig.model,
        systemPrompt: aiConfig.systemPrompt,
        triggerConfig: aiConfig.triggerConfig,
        groupOverrides: aiConfig.groupOverrides,
        conversationConfig: conversationCfg,
        conversation,
        memoryConfig: memoryCfg,
        memory,
        stickerPacks: aiConfig.stickerPacks,
      };
    }

    const manager = new BotManager({
      botId,
      token,
      adminChatIds: bot.adminChatIds,
      logger: this.logger,
      dbLogger,
      aiReply,
      conversation,
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
