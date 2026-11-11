import type { AiProviderRuntime } from "@cos-tool-bot/bot";
import { removeProfileAvatarFile } from "@cos-tool-bot/bot";
import type {
  ConversationCallbacks,
  ConversationConfig,
  UserPrivacyCallbacks,
} from "@cos-tool-bot/shared";
import { getDataDir } from "@cos-tool-bot/shared/file-validation";
import type { Logger } from "pino";
import { compressConversation } from "../conversation-compressor.js";
import { ConversationHistoryGovernor } from "../conversation-history-governor.js";
import type { ConversationStore } from "../conversation-store.js";
import type { DbLogger } from "../db-logger.js";
import type { EmbeddingService } from "../embedding-service.js";
import type { UserPrivacyService } from "../user-privacy-service.js";
import type { BotRuntimeHost } from "./types.js";

const CONVERSATION_GOVERNANCE_STARTUP_GRACE_MS = 15_000;

export function createPrivacyCallbacks(
  botId: string,
  privacyService: UserPrivacyService,
  dbLogger: DbLogger,
): UserPrivacyCallbacks {
  return {
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
}

export function resolveCompressionProvider(
  conversationCfg: ConversationConfig,
  providersRuntime: AiProviderRuntime[],
  activeProvider: AiProviderRuntime,
  dbLogger: DbLogger,
): AiProviderRuntime {
  const compressionProvider = conversationCfg.compressionProviderId
    ? (providersRuntime.find((provider) => provider.id === conversationCfg.compressionProviderId) ??
      activeProvider)
    : activeProvider;
  if (
    conversationCfg.compressionProviderId &&
    compressionProvider.id !== conversationCfg.compressionProviderId
  ) {
    dbLogger.warn(
      `Conversation compression Provider ${conversationCfg.compressionProviderId} is unavailable; using the active Provider`,
    );
  }
  return compressionProvider;
}

export interface ConversationRuntimeInput {
  botId: string;
  conversationCfg: ConversationConfig;
  compressionProvider: AiProviderRuntime;
  embeddingService: EmbeddingService | undefined;
  auxiliaryTimeoutMs: number;
  store: ConversationStore;
  dbLogger: DbLogger;
  logger: Logger;
  host: Pick<BotRuntimeHost, "triggerConversationCleanup">;
}

export function createConversationRuntime({
  botId,
  conversationCfg,
  compressionProvider,
  embeddingService,
  auxiliaryTimeoutMs,
  store,
  dbLogger,
  logger,
  host,
}: ConversationRuntimeInput): {
  conversation: ConversationCallbacks;
  runInitialHistoryGovernance: () => Promise<void>;
} {
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
          logger,
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
      logger,
      force: true,
      keepRecent: 0,
      abortSignal: AbortSignal.timeout(auxiliaryTimeoutMs),
    });
  const runInitialHistoryGovernance = async () => {
    if (conversationCfg.maxRawMessagesPerChat <= 0) return;
    const warningThreshold = Math.floor(conversationCfg.maxRawMessagesPerChat * 0.8);
    const chats = await store.listChatsAtOrAboveMessageCount(botId, warningThreshold);
    const hardLimitFirst = chats.sort((left, right) => right.count - left.count);
    for (const chat of hardLimitFirst) {
      await governChat(chat.chatId, CONVERSATION_GOVERNANCE_STARTUP_GRACE_MS);
    }
  };

  const conversation: ConversationCallbacks = {
    findOwnMessage: (chatId, messageId) => store.findOwnMessage(botId, chatId, messageId),
    updateOwnMessage: (chatId, messageId, content) =>
      store.updateOwnMessage(botId, chatId, messageId, content),
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
            message.content.length > 0 && (message.role === "user" || message.role === "assistant"),
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
                await store.updateEmbeddingIfContentMatches(
                  botId,
                  toEmbed[i]!.id,
                  toEmbed[i]!.content,
                  emb,
                );
              }
            }
          } catch (err) {
            logger.warn(err, "Batch message embedding generation failed");
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
            if (embedding)
              return store.updateEmbeddingIfContentMatches(
                botId,
                persisted.id,
                persisted.content,
                embedding,
              );
          })
          .catch((err) => {
            logger.warn(err, "Group message embedding generation failed");
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
      host.triggerConversationCleanup(botId, conversationCfg.retentionDays);
      await ensureChatCompression(chatId);
    },
    triggerCompression: async (chatId) => {
      host.triggerConversationCleanup(botId, conversationCfg.retentionDays);
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

  return { conversation, runInitialHistoryGovernance };
}
