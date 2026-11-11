import { readActivePromptSnapshot } from "../prompt-versions.js";
import type {
  AiReplyBotConfig,
  AiSelectionCallbacks,
  AiSelectionSnapshot,
  BotAiSelectionRuntime,
} from "@cos-tool-bot/bot";
import { resolveBotSkills } from "@cos-tool-bot/bot";
import { bots } from "@cos-tool-bot/database";
import type { AiConfigStored, ConversationCallbacks, EngagementSample } from "@cos-tool-bot/shared";
import {
  DEFAULT_CONVERSATION_CONFIG,
  DEFAULT_MEMORY_CONFIG,
  DEFAULT_TIMEOUT_CONFIG,
} from "@cos-tool-bot/shared";
import { eq } from "drizzle-orm";
import { createDataFilesLoader } from "../../utils/data-files-loader.js";
import {
  applyGroupOverride,
  applyMessageConfigUpdate,
  applyWebToolApiKey,
  type AiConfigRuntime,
} from "../ai-config-runtime.js";
import type {
  ChatAiSelectionRuntime,
  ChatAiSelectionRuntimeSnapshot,
} from "../chat-ai-selection-runtime-registry.js";
import type { DbLogger } from "../db-logger.js";
import { createBotEmbeddingService, type EmbeddingService } from "../embedding-service.js";
import { createConversationRuntime, resolveCompressionProvider } from "./conversation.js";
import { createGitHubCodeCallbacks, resolveGitHubToolsConfig } from "./github-tools.js";
import { createMcpToolsConfig } from "./mcp.js";
import { createBotMemoryCallbacks, createMemoryCallbacks } from "./memory.js";
import { createRssCallbacks } from "./rss.js";
import type { BotRuntimeHost, BotRuntimeServices } from "./types.js";

export interface AiReplyRuntime {
  aiReply: AiReplyBotConfig;
  aiSelectionCallbacks?: AiSelectionCallbacks;
  conversation: ConversationCallbacks;
  embeddingService?: EmbeddingService;
  runInitialHistoryGovernance: () => Promise<void>;
}

/** Undefined when AI replies are disabled or no Provider API key could be decrypted. */
export async function assembleAiReply(
  botId: string,
  aiRuntime: AiConfigRuntime,
  dbLogger: DbLogger,
  services: Readonly<BotRuntimeServices>,
  host: BotRuntimeHost,
): Promise<AiReplyRuntime | undefined> {
  const aiConfig = aiRuntime.config;
  const runtimeTimeoutConfig = aiRuntime.timeoutConfig;
  const auxiliaryTimeoutMs = runtimeTimeoutConfig?.perStepMs ?? DEFAULT_TIMEOUT_CONFIG.perStepMs;
  const providersRuntime = aiRuntime.providers;
  const activeProvider = aiRuntime.activeProvider;
  if (!aiConfig.enabled || !activeProvider) return undefined;

  const apiKey = activeProvider.apiKey;
  const githubToolsConfig = resolveGitHubToolsConfig(botId, aiRuntime, dbLogger, services);
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
  const compressionProvider = resolveCompressionProvider(
    conversationCfg,
    providersRuntime,
    activeProvider,
    dbLogger,
  );

  const embeddingService = createBotEmbeddingService(aiRuntime, services.logger);
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

  const { conversation, runInitialHistoryGovernance } = createConversationRuntime({
    botId,
    conversationCfg,
    compressionProvider,
    embeddingService,
    auxiliaryTimeoutMs,
    store: services.conversationStore,
    dbLogger,
    logger: services.logger,
    host,
  });

  const memoryCfg = aiConfig.memoryConfig ?? DEFAULT_MEMORY_CONFIG;
  const memory = memoryCfg.enabled
    ? createMemoryCallbacks(botId, embeddingService, auxiliaryTimeoutMs, services)
    : undefined;

  const botMemoryCfg = aiConfig.botMemoryConfig;
  const botMemory = botMemoryCfg?.enabled
    ? createBotMemoryCallbacks(botId, botMemoryCfg, embeddingService, auxiliaryTimeoutMs, services)
    : undefined;

  const durableSelection = services.chatAiSelectionService
    ? await services.chatAiSelectionService.loadRuntimeSnapshot(botId)
    : undefined;
  const aiSelectionCallbacks = createAiSelectionCallbacks(botId, services, host);

  const dataFilesConfig = aiConfig.dataFilesConfig;
  const dataFiles = await createDataFilesLoader(botId, {
    injectableFiles: dataFilesConfig?.injectableFiles,
    maxTotalSize: dataFilesConfig?.maxTotalSize,
  });

  const aiReply: AiReplyBotConfig = {
    botId,
    getPromptSnapshot: () => readActivePromptSnapshot(services.db, botId),
    scheduledTasks: services.scheduledTasks,
    apiKey,
    baseURL: activeProvider.baseURL,
    model: aiConfig.activeModelId ?? activeProvider.defaultModel,
    providerFormat: activeProvider.providerFormat,
    providers: providersRuntime,
    activeProviderId: activeProvider.id,
    activeModelId: aiConfig.activeModelId ?? activeProvider.defaultModel,
    aiSelectionSnapshot: durableSelection ? toBotAiSelectionSnapshot(durableSelection) : undefined,
    systemPrompt: aiConfig.systemPrompt,
    behavioralPrompt: aiConfig.behavioralPrompt,
    groupBehavioralPrompt: aiConfig.groupBehavioralPrompt,
    triggerConfig: aiConfig.triggerConfig,
    engagement: aiRuntime.engagement,
    onEngagementSample: async (sample) => {
      if (!services.engagementSampleService) return;
      try {
        await persistEngagementSample(
          services,
          botId,
          sample,
          [
            aiRuntime.engagement.apiKey,
            ...providersRuntime.map((provider) => provider.apiKey),
          ].filter((secret): secret is string => !!secret),
        );
      } catch (error) {
        services.logger.error({ error, botId }, "Failed to persist engagement sample");
      }
    },
    groupOverrides: aiConfig.groupOverrides,
    imageGenerationConfirmation: aiConfig.imageGenerationConfirmation ?? "always",
    conversationConfig: conversationCfg,
    conversation,
    memoryConfig: memoryCfg,
    memory,
    stickerPacks: aiConfig.stickerPacks,
    webToolsConfig: aiConfig.webToolsConfig,
    unifiedSearchEnabled: aiConfig.unifiedSearchEnabled !== false,
    plugins: services.plugins,
    mediaTranscriptionPort: services.mediaTranscriptionPort,
    imageGenerationPort: services.imageGenerationPort,
    generationLibraryPort: services.generationLibraryService,
    skills: resolveBotSkills(aiConfig.skillConfig),
    isDelegatedGroupAdmin: (chatId, userId) => host.isDelegatedGroupAdmin(botId, chatId, userId),
    usageGovernance: services.usageGovernance,
    agentToolsConfig: aiConfig.agentToolsConfig,
    githubToolsConfig,
    githubIssueProposals: services.githubIssueProposalService?.forBot(botId),
    githubCodeCallbacks: createGitHubCodeCallbacks(botId, githubToolsConfig, services),
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
        await updateStoredAiConfig(services, host, botId, (current) =>
          applyGroupOverride(current, chatId, override),
        );
      } catch (err) {
        services.logger.error(err, "Failed to persist group override update");
      }
    },
    onMessageConfigUpdate: async (updates) => {
      try {
        const updated = await updateStoredAiConfig(services, host, botId, (current) =>
          applyMessageConfigUpdate(current, updates),
        );
        if (!updated) throw new Error("AI is not configured");
      } catch (error) {
        services.logger.error(error, "Failed to persist message config update");
        throw error;
      }
    },
    onWebToolApiKeyUpdate: async (target, apiKey) => {
      const updated = await updateStoredAiConfig(services, host, botId, (current) =>
        applyWebToolApiKey(current, target, apiKey),
      );
      if (!updated) throw new Error("Web tools are not configured");
    },
    rssCallbacks: services.rssFeedService
      ? createRssCallbacks(botId, services.rssFeedService)
      : undefined,
    mcpTools: createMcpToolsConfig(services.mcpClientManager, aiConfig.mcpServerIds),
  };

  return {
    aiReply,
    aiSelectionCallbacks,
    conversation,
    embeddingService,
    runInitialHistoryGovernance,
  };
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

function createAiSelectionCallbacks(
  botId: string,
  services: Readonly<BotRuntimeServices>,
  host: BotRuntimeHost,
): AiSelectionCallbacks | undefined {
  if (!services.chatAiSelectionService || !services.chatAiSelectionRuntimeRegistry)
    return undefined;
  const service = services.chatAiSelectionService;
  const registry = services.chatAiSelectionRuntimeRegistry;
  return {
    setModel: (chatId, modelId, actorTelegramUserId) =>
      service.setModelFromTelegram(botId, chatId, modelId, actorTelegramUserId),
    resetModel: (chatId, actorTelegramUserId) =>
      service.resetModelFromTelegram(botId, chatId, actorTelegramUserId),
    setProvider: (chatId, providerId, actorTelegramUserId) =>
      service.setProviderFromTelegram(botId, chatId, providerId, actorTelegramUserId),
    resetProvider: (chatId, actorTelegramUserId) =>
      service.resetProviderFromTelegram(botId, chatId, actorTelegramUserId),
    onBotReady: (runtime: BotAiSelectionRuntime) => {
      host.replaceAiSelectionRuntime(botId, () => {
        const adapter: ChatAiSelectionRuntime = {
          apply: async (snapshot) => {
            runtime.applyAiSelectionSnapshot(toBotAiSelectionSnapshot(snapshot));
          },
        };
        return registry.register(botId, adapter);
      });
    },
  };
}

/** Returns false when the bot has no stored AI config; no write happens. */
function updateStoredAiConfig(
  services: Readonly<BotRuntimeServices>,
  host: BotRuntimeHost,
  botId: string,
  mutate: (current: AiConfigStored) => AiConfigStored,
): Promise<boolean> {
  return host.withAiConfigLock(botId, () =>
    services.db.transaction(async (tx) => {
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

async function persistEngagementSample(
  services: Readonly<BotRuntimeServices>,
  botId: string,
  sample: EngagementSample,
  secrets: readonly string[],
): Promise<void> {
  const engagementSampleService = services.engagementSampleService;
  if (!engagementSampleService) return;
  await services.userPrivacyService.runWithEngagementContextPrivacy(
    botId,
    sample.context,
    (context) => engagementSampleService.persist(botId, { ...sample, context }, secrets),
  );
}
