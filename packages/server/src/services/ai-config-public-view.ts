import { EMBEDDING_DIMENSIONS } from "@cos-tool-bot/database";
import {
  DEFAULT_AI_EXECUTION_CONFIG,
  DEFAULT_ENGAGEMENT_POLICY,
  toWebToolsConfigPublic,
} from "@cos-tool-bot/shared";
import type {
  AiConfigPublic,
  AiConfigStored,
  EmbeddingConfig,
  EmbeddingConfigPublic,
  GitHubToolsConfigPublic,
  GitHubToolsConfigStored,
} from "@cos-tool-bot/shared";
import { getActiveProvider, migrateAiConfig } from "../utils/ai-config-migrate.js";
import { resolvePixaiTaskTimeoutMs } from "./generation-recovery.js";

function emptyAiConfigPublic(): AiConfigPublic {
  return {
    engagement: { ...DEFAULT_ENGAGEMENT_POLICY, hasApiKey: false },
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
    imageGenerationConfirmation: "always",
    providers: [],
    unifiedSearchEnabled: true,
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
    createIssueConfirmationTtlMinutes: stored.createIssueConfirmationTtlMinutes ?? null,
    codingProviderId: stored.codingProviderId,
    codingModelId: stored.codingModelId,
    hasToken: !!stored.encryptedToken && !stored.githubAppInstallation,
    login: stored.githubAppInstallation?.accountLogin ?? stored.login,
    authorName: stored.authorName,
    authorEmail: stored.authorEmail,
    repositories: stored.githubAppInstallation ? [] : stored.repositories,
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

function toEngagementConfigPublic(stored: AiConfigStored["engagement"]) {
  return {
    mode: stored?.mode ?? DEFAULT_ENGAGEMENT_POLICY.mode,
    style: stored?.style ?? DEFAULT_ENGAGEMENT_POLICY.style,
    preferences: stored?.preferences ?? DEFAULT_ENGAGEMENT_POLICY.preferences,
    keywordDirect: stored?.keywordDirect ?? DEFAULT_ENGAGEMENT_POLICY.keywordDirect,
    cooldownSeconds: stored?.cooldownSeconds ?? DEFAULT_ENGAGEMENT_POLICY.cooldownSeconds,
    confidenceThreshold:
      stored?.confidenceThreshold ?? DEFAULT_ENGAGEMENT_POLICY.confidenceThreshold,
    addressedConfidenceThreshold:
      stored?.addressedConfidenceThreshold ??
      DEFAULT_ENGAGEMENT_POLICY.addressedConfidenceThreshold,
    continueConfidenceThreshold:
      stored?.continueConfidenceThreshold ?? DEFAULT_ENGAGEMENT_POLICY.continueConfidenceThreshold,
    continuationWindowSeconds:
      stored?.continuationWindowSeconds ?? DEFAULT_ENGAGEMENT_POLICY.continuationWindowSeconds,
    contextMessages: stored?.contextMessages ?? DEFAULT_ENGAGEMENT_POLICY.contextMessages,
    timeoutMs: stored?.timeoutMs ?? DEFAULT_ENGAGEMENT_POLICY.timeoutMs,
    hasApiKey: !!stored?.encryptedApiKey,
  };
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
    excludedModelIds: p.excludedModelIds,
  }));
  return {
    engagement: toEngagementConfigPublic(migrated.engagement),
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
    imageGenerationConfirmation: migrated.imageGenerationConfirmation ?? "always",
    conversationConfig: migrated.conversationConfig,
    memoryConfig: migrated.memoryConfig,
    stickerPacks: migrated.stickerPacks,
    webToolsConfig: toWebToolsConfigPublic(migrated.webToolsConfig),
    unifiedSearchEnabled: migrated.unifiedSearchEnabled !== false,
    imageGenerationReceiptConfig: migrated.imageGenerationReceiptConfig,
    agentToolsConfig: migrated.agentToolsConfig,
    taskAgentConfig: migrated.taskAgentConfig,
    githubToolsConfig: toGitHubToolsConfigPublic(migrated.githubToolsConfig),
    artworkToolsConfig: migrated.artworkToolsConfig,
    botMemoryConfig: migrated.botMemoryConfig,
    messageConfig: migrated.messageConfig,
    modelRecovery: migrated.modelRecovery,
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
