import type { BotMemoryCallbacks, BotMemoryConfig, MemoryCallbacks } from "@cos-tool-bot/shared";
import { getDataDir } from "@cos-tool-bot/shared";
import { BotMemoryWriter } from "../bot-memory-writer.js";
import type { EmbeddingService } from "../embedding-service.js";
import { mapProfileToDto } from "../people-profile-store.js";
import { selectMemoriesForPrompt } from "../prompt-memory-selector.js";
import type { BotRuntimeServices } from "./types.js";

export function createMemoryCallbacks(
  botId: string,
  embeddingService: EmbeddingService | undefined,
  auxiliaryTimeoutMs: number,
  services: Readonly<BotRuntimeServices>,
): MemoryCallbacks {
  const ps = services.profileStore;
  const cs = services.conversationStore;
  return {
    getProfile: (telegramId) =>
      ps.getProfile(botId, telegramId).then((p) => (p ? mapProfileToDto(p) : null)),
    getProfileAvatar: (telegramId, requesterTelegramId) =>
      services.profileAvatarService.getProfileAvatar(
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

export function createBotMemoryCallbacks(
  botId: string,
  botMemoryCfg: BotMemoryConfig,
  embeddingService: EmbeddingService | undefined,
  auxiliaryTimeoutMs: number,
  services: Readonly<BotRuntimeServices>,
): BotMemoryCallbacks {
  const ms = services.botMemoryStore;
  const es = embeddingService;
  // Turns can run before start() returns and registers `es` for the Pool-level writer.
  const memoryWriter = new BotMemoryWriter(ms, () => es, services.logger);

  return {
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
      const pStore = services.profileStore;
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
