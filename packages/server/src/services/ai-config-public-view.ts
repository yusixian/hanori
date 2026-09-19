import { EMBEDDING_DIMENSIONS } from "@cos-tool-bot/database";
import { DEFAULT_AI_EXECUTION_CONFIG } from "@cos-tool-bot/shared";
import type {
  AiConfigPublic,
  AiConfigStored,
  EmbeddingConfig,
  EmbeddingConfigPublic,
  GitHubToolsConfigPublic,
  GitHubToolsConfigStored,
} from "@cos-tool-bot/shared";
import { getActiveProvider, migrateAiConfig } from "../utils/ai-config-migrate.js";
import { toWebToolsConfigPublic } from "./ai-config-web-tools.js";
import { resolvePixaiTaskTimeoutMs } from "./generation-recovery.js";

function emptyAiConfigPublic(): AiConfigPublic {
  return {
    enabled: false,
    hasApiKey: false,
    baseURL: "",
    model: "",
    systemPrompt: "",
    triggerConfig: {
      replyToBot: true,
      mentionBot: true,
      triggerWords: [],
      randomReplyPercent: 0,
      randomReplyCooldown: 60,
    },
    groupOverrides: {},
    providers: [],
    executionConfig: DEFAULT_AI_EXECUTION_CONFIG,
  };
}

export function toGitHubToolsConfigPublic(
  stored: GitHubToolsConfigStored | undefined,
): GitHubToolsConfigPublic | undefined {
  if (!stored) return undefined;
  return {
    enabled: stored.enabled,
    publicReadEnabled: stored.publicReadEnabled,
    codingAgentEnabled: stored.codingAgentEnabled ?? false,
    codingProviderId: stored.codingProviderId,
    codingModelId: stored.codingModelId,
    hasToken: !!stored.encryptedToken,
    login: stored.githubAppInstallation?.accountLogin ?? stored.login,
    authorName: stored.authorName,
    authorEmail: stored.authorEmail,
    repositories: stored.repositories,
  };
}

export function toEmbeddingConfigPublic(
  stored: EmbeddingConfig | undefined,
): EmbeddingConfigPublic | undefined {
  if (!stored) return undefined;
  return {
    enabled: stored.enabled,
    hasApiKey: !!stored.encryptedApiKey,
    baseURL: stored.baseURL,
    model: stored.model,
    dimensions: EMBEDDING_DIMENSIONS,
  };
}

export function hasActiveApiKey(stored: AiConfigStored | null | undefined): boolean {
  return !!(stored && getActiveProvider(migrateAiConfig(stored))?.encryptedApiKey);
}

export function toAiConfigPublic(config: AiConfigStored | null | undefined): AiConfigPublic {
  if (!config) return emptyAiConfigPublic();
  const migrated = migrateAiConfig(config);
  // migrateAiConfig guarantees providers[] non-empty, so active is always set.
  const active = getActiveProvider(migrated)!;
  const providers = migrated.providers!.map((p) => ({
    id: p.id,
    label: p.label,
    hasApiKey: !!p.encryptedApiKey,
    baseURL: p.baseURL,
    modelDiscoveryPath: p.modelDiscoveryPath,
    providerFormat: p.providerFormat,
    defaultModel: p.defaultModel,
    models: p.models,
  }));
  return {
    enabled: migrated.enabled,
    hasApiKey: !!active.encryptedApiKey,
    baseURL: active.baseURL,
    model: migrated.activeModelId ?? active.defaultModel,
    providerFormat: active.providerFormat,
    providers,
    activeProviderId: migrated.activeProviderId,
    activeModelId: migrated.activeModelId,
    aiSelectionDisplayDefault: migrated.aiSelectionDisplayDefault,
    systemPrompt: migrated.systemPrompt,
    behavioralPrompt: migrated.behavioralPrompt,
    groupBehavioralPrompt: migrated.groupBehavioralPrompt,
    triggerConfig: migrated.triggerConfig,
    groupOverrides: migrated.groupOverrides,
    conversationConfig: migrated.conversationConfig,
    memoryConfig: migrated.memoryConfig,
    stickerPacks: migrated.stickerPacks,
    webToolsConfig: toWebToolsConfigPublic(migrated.webToolsConfig),
    imageGenerationReceiptConfig: migrated.imageGenerationReceiptConfig,
    agentToolsConfig: migrated.agentToolsConfig,
    githubToolsConfig: toGitHubToolsConfigPublic(migrated.githubToolsConfig),
    artworkToolsConfig: migrated.artworkToolsConfig,
    botMemoryConfig: migrated.botMemoryConfig,
    messageConfig: migrated.messageConfig,
    executionConfig: migrated.executionConfig ?? DEFAULT_AI_EXECUTION_CONFIG,
    models: active.models ?? migrated.models,
    modelCommandAccess: migrated.modelCommandAccess,
    embeddingConfig: toEmbeddingConfigPublic(migrated.embeddingConfig),
    dataFilesConfig: migrated.dataFilesConfig,
    privateChatAccess: migrated.privateChatAccess ?? "all",
    privateChatWhitelist: migrated.privateChatWhitelist,
    timeoutConfig:
      migrated.timeoutConfig?.pixaiTaskMs === undefined
        ? migrated.timeoutConfig
        : {
            ...migrated.timeoutConfig,
            pixaiTaskMs: resolvePixaiTaskTimeoutMs(migrated.timeoutConfig.pixaiTaskMs),
          },
    mcpServerIds: migrated.mcpServerIds,
    summaryConfig: migrated.summaryConfig,
    imageOcrConfig: migrated.imageOcrConfig,
  };
}

export function aiConfigRevision(updatedAt: Date | null | undefined): string {
  return updatedAt?.toISOString() ?? "0";
}
