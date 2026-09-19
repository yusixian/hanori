import type { client } from "@/lib/client";
import type {
  AiConfigPublic,
  AiExecutionConfig,
  ImageOcrConfig,
  SummaryConfigStored,
  WebToolsConfig,
  WebToolsConfigPublic,
} from "@cos-tool-bot/shared";
import type { InferRequestType } from "hono/client";

export type AiConfigSaveBody = InferRequestType<
  (typeof client.api.bots)[":botId"]["ai-config"]["$put"]
>["json"];

export interface AiConfigSaveInput {
  revision: string;
  config: AiConfigPublic;
  triggerWordsText: string;
  stickerPacksText: string;
  summaryConfig: SummaryConfigStored;
  imageOcrConfig: ImageOcrConfig;
  executionConfig: AiExecutionConfig;
  providerApiKeys: Record<string, string>;
  webSearchApiKey: string;
  webImageApiKey: string;
  embeddingApiKey: string;
}

function toWebToolsConfigUpdate(
  config: WebToolsConfigPublic | undefined,
  searchApiKey: string,
  imageApiKey: string,
): WebToolsConfig | undefined {
  if (!config) return undefined;
  return {
    enabled: config.enabled,
    trustedPrivateHosts: config.trustedPrivateHosts,
    search: config.search
      ? {
          provider: config.search.provider,
          apiKey: searchApiKey || undefined,
          baseURL: config.search.baseURL,
        }
      : undefined,
    imageGeneration: config.imageGeneration
      ? {
          provider: config.imageGeneration.provider,
          apiKey: imageApiKey || undefined,
          baseURL: config.imageGeneration.baseURL,
          model: config.imageGeneration.model,
          size: config.imageGeneration.size,
          pixaiConfig: config.imageGeneration.pixaiConfig,
        }
      : undefined,
  };
}

export function buildAiConfigSaveBody(input: AiConfigSaveInput): AiConfigSaveBody {
  const {
    revision,
    config,
    triggerWordsText,
    stickerPacksText,
    summaryConfig,
    imageOcrConfig,
    executionConfig,
    providerApiKeys,
    webSearchApiKey,
    webImageApiKey,
    embeddingApiKey,
  } = input;
  const activeProvider =
    config.providers?.find((provider) => provider.id === config.activeProviderId) ??
    config.providers?.[0];

  return {
    revision,
    enabled: config.enabled,
    baseURL: activeProvider?.baseURL ?? config.baseURL,
    providerFormat: activeProvider?.providerFormat ?? config.providerFormat,
    model: activeProvider?.defaultModel ?? config.model,
    systemPrompt: config.systemPrompt,
    behavioralPrompt: config.behavioralPrompt || undefined,
    groupBehavioralPrompt: config.groupBehavioralPrompt || undefined,
    triggerConfig: {
      ...config.triggerConfig,
      triggerWords: triggerWordsText
        .split(",")
        .map((word) => word.trim())
        .filter(Boolean),
    },
    groupOverrides: config.groupOverrides,
    conversationConfig: config.conversationConfig,
    memoryConfig: config.memoryConfig,
    botMemoryConfig: config.botMemoryConfig,
    webToolsConfig: toWebToolsConfigUpdate(config.webToolsConfig, webSearchApiKey, webImageApiKey),
    imageGenerationReceiptConfig: config.imageGenerationReceiptConfig,
    agentToolsConfig: config.agentToolsConfig,
    githubToolsConfig: config.githubToolsConfig
      ? {
          enabled: config.githubToolsConfig.enabled,
          publicReadEnabled: config.githubToolsConfig.publicReadEnabled,
          codingAgentEnabled: config.githubToolsConfig.codingAgentEnabled,
          codingProviderId: config.githubToolsConfig.codingProviderId,
          codingModelId: config.githubToolsConfig.codingModelId,
          authorName: config.githubToolsConfig.authorName,
          authorEmail: config.githubToolsConfig.authorEmail,
          repositories: config.githubToolsConfig.repositories,
        }
      : undefined,
    artworkToolsConfig: config.artworkToolsConfig,
    messageConfig: config.messageConfig,
    timeoutConfig: config.timeoutConfig,
    models: activeProvider?.models ?? config.models,
    modelCommandAccess: config.modelCommandAccess,
    embeddingConfig: config.embeddingConfig
      ? {
          enabled: config.embeddingConfig.enabled,
          apiKey: embeddingApiKey || undefined,
          baseURL: config.embeddingConfig.baseURL,
          model: config.embeddingConfig.model,
        }
      : undefined,
    privateChatWhitelist: config.privateChatWhitelist,
    privateChatAccess: config.privateChatAccess ?? "all",
    mcpServerIds: config.mcpServerIds,
    summaryConfig,
    imageOcrConfig,
    executionConfig,
    stickerPacks: stickerPacksText
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
    providers: config.providers?.map((p) => ({
      // Keep temp "__new_*" ids so backend can remap activeProviderId through them.
      id: p.id,
      label: p.label,
      baseURL: p.baseURL,
      providerFormat: p.providerFormat,
      defaultModel: p.defaultModel,
      modelDiscoveryPath: p.modelDiscoveryPath,
      apiKey: providerApiKeys[p.id] || undefined,
      models: p.models,
    })),
    activeProviderId: config.activeProviderId,
  };
}
