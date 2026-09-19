import { randomUUID } from "node:crypto";
import { EMBEDDING_DIMENSIONS } from "@cos-tool-bot/database";
import {
  DEFAULT_AI_EXECUTION_CONFIG,
  resolveImageGenerationReceiptConfig,
} from "@cos-tool-bot/shared";
import type { AiConfigStored, AiProviderEntry } from "@cos-tool-bot/shared";
import { migrateAiConfig, normalizeAiProvider } from "../utils/ai-config-migrate.js";
import { encrypt } from "../utils/crypto.js";
import { normalizeBaseURLForComparison, type AiConfigPatch } from "./ai-config-schema.js";
import { mergeWebToolsApiKeys } from "./ai-config-web-tools.js";
import { resolvePixaiTaskTimeoutMs } from "./generation-recovery.js";
import {
  assertGitHubCodingModelSelection,
  assertGitHubCredentialUpdateAllowed,
} from "./github-credential-policy.js";

/** Rejection of an AI config patch that the schema cannot catch. Routes map it to HTTP 400. */
export class AiConfigPatchError extends Error {}

export interface AbsorbAiConfigPatchInput {
  current: AiConfigStored | null | undefined;
  patch: AiConfigPatch;
  actorRole: string;
  encryptionKey: string;
}

export function absorbAiConfigPatch(input: AbsorbAiConfigPatchInput): AiConfigStored {
  const { current, patch, actorRole, encryptionKey } = input;

  // Migrate existing stored config first so we can reliably look up per-provider
  // encrypted keys by id when the client sends back the same provider without a new apiKey.
  const existingMigrated = current ? migrateAiConfig(current) : null;
  const existingProvidersById = new Map<string, AiProviderEntry>();
  for (const p of existingMigrated?.providers ?? []) {
    existingProvidersById.set(p.id, p);
  }

  // Build new providers list with preserve-when-empty apiKey per entry.
  // Client sends temp ids like "__new_xxx" for unsaved providers; map them to real
  // UUIDs here. Runtime selection is deliberately preserved from the latest stored
  // config; the dedicated ai-selection endpoint is its only ordinary writer.
  let providers: AiProviderEntry[] | undefined;
  let requestedInitialProviderId: string | undefined = patch.activeProviderId;
  const providerIdMap = new Map<string, string>();
  if (patch.providers !== undefined) {
    providers = patch.providers.map((p) => {
      const isTemp = !p.id || p.id.startsWith("__new_");
      const finalId = isTemp ? randomUUID() : p.id!;
      if (p.id) providerIdMap.set(p.id, finalId);
      const existing = isTemp ? undefined : existingProvidersById.get(finalId);
      const suppliedApiKey = p.apiKey?.trim();
      const changedBaseURL =
        existing !== undefined &&
        normalizeBaseURLForComparison(existing.baseURL) !==
          normalizeBaseURLForComparison(p.baseURL);
      if (existing?.encryptedApiKey && changedBaseURL && !suppliedApiKey) {
        throw new AiConfigPatchError(
          `Provider "${p.label}" requires a new API key when its base URL changes`,
        );
      }
      const encryptedApiKey = suppliedApiKey
        ? encrypt(suppliedApiKey, encryptionKey)
        : (existing?.encryptedApiKey ?? null);
      return normalizeAiProvider({
        id: finalId,
        label: p.label,
        encryptedApiKey,
        baseURL: p.baseURL,
        modelDiscoveryPath: p.modelDiscoveryPath,
        providerFormat: p.providerFormat,
        defaultModel: p.defaultModel,
        models: p.models,
      });
    });
    if (requestedInitialProviderId && providerIdMap.has(requestedInitialProviderId)) {
      requestedInitialProviderId = providerIdMap.get(requestedInitialProviderId);
    }
  }
  const effectiveProviders = providers ?? existingMigrated?.providers ?? [];
  const existingProviderId = existingMigrated?.activeProviderId;
  const selectedProviderId = existingMigrated
    ? effectiveProviders.some((provider) => provider.id === existingProviderId)
      ? existingProviderId
      : effectiveProviders[0]?.id
    : effectiveProviders.some((provider) => provider.id === requestedInitialProviderId)
      ? requestedInitialProviderId
      : effectiveProviders[0]?.id;
  const selectedProvider = effectiveProviders.find(
    (provider) => provider.id === selectedProviderId,
  );
  const requestedActiveModelId =
    existingMigrated && selectedProviderId === existingMigrated.activeProviderId
      ? existingMigrated.activeModelId
      : !existingMigrated
        ? patch.activeModelId
        : undefined;
  if (
    requestedActiveModelId &&
    selectedProvider &&
    requestedActiveModelId !== selectedProvider.defaultModel &&
    !selectedProvider.models?.some((model) => model.id === requestedActiveModelId)
  ) {
    throw new AiConfigPatchError("The selected model is not available for the active Provider");
  }
  const activeModelId = requestedActiveModelId ?? selectedProvider?.defaultModel;

  // Legacy top-level apiKey handling (kept for backward-compat clients that don't yet
  // send providers[]). Preserve-when-empty.
  let encryptedApiKey = current?.encryptedApiKey ?? null;
  if (patch.apiKey !== undefined && patch.apiKey !== "") {
    encryptedApiKey = encrypt(patch.apiKey, encryptionKey);
  }

  // If model is empty but models array has entries, use first model as default
  const effectiveModel =
    patch.model || (patch.models?.length ? patch.models[0]!.id : (current?.model ?? ""));

  // Handle embedding config encryption
  let embeddingConfig = current?.embeddingConfig;
  if (patch.embeddingConfig) {
    let embEncryptedApiKey = embeddingConfig?.encryptedApiKey ?? "";
    if (patch.embeddingConfig.apiKey) {
      embEncryptedApiKey = encrypt(patch.embeddingConfig.apiKey, encryptionKey);
    }
    embeddingConfig = {
      enabled: patch.embeddingConfig.enabled,
      encryptedApiKey: embEncryptedApiKey,
      baseURL: patch.embeddingConfig.baseURL,
      model: patch.embeddingConfig.model,
      dimensions: EMBEDDING_DIMENSIONS,
    };
  }

  let githubToolsConfig = current?.githubToolsConfig;
  if (patch.githubToolsConfig) {
    const requestedCodingProviderId = patch.githubToolsConfig.codingProviderId
      ? (providerIdMap.get(patch.githubToolsConfig.codingProviderId) ??
        patch.githubToolsConfig.codingProviderId)
      : undefined;
    assertGitHubCodingModelSelection(
      effectiveProviders,
      requestedCodingProviderId,
      patch.githubToolsConfig.codingModelId,
    );
    assertGitHubCredentialUpdateAllowed(actorRole, githubToolsConfig, patch.githubToolsConfig);
    const encryptedToken = patch.githubToolsConfig.token
      ? encrypt(patch.githubToolsConfig.token, encryptionKey)
      : githubToolsConfig?.encryptedToken;
    githubToolsConfig = {
      ...githubToolsConfig,
      enabled: patch.githubToolsConfig.enabled,
      publicReadEnabled: patch.githubToolsConfig.publicReadEnabled,
      codingAgentEnabled: patch.githubToolsConfig.codingAgentEnabled,
      codingProviderId: requestedCodingProviderId,
      codingModelId: patch.githubToolsConfig.codingModelId,
      encryptedToken,
      login:
        patch.githubToolsConfig.login === undefined
          ? githubToolsConfig?.login
          : patch.githubToolsConfig.login || undefined,
      authorName: patch.githubToolsConfig.authorName,
      authorEmail: patch.githubToolsConfig.authorEmail,
      repositories: [
        ...new Set(patch.githubToolsConfig.repositories.map((repo) => repo.toLowerCase())),
      ],
    };
  }
  if (githubToolsConfig) {
    assertGitHubCodingModelSelection(
      providers ?? existingMigrated?.providers ?? [],
      githubToolsConfig.codingProviderId,
      githubToolsConfig.codingModelId,
    );
  }
  const imageOcrConfig = patch.imageOcrConfig
    ? {
        ...patch.imageOcrConfig,
        providerId: patch.imageOcrConfig.providerId
          ? (providerIdMap.get(patch.imageOcrConfig.providerId) ?? patch.imageOcrConfig.providerId)
          : undefined,
      }
    : current?.imageOcrConfig;
  const conversationConfig = patch.conversationConfig
    ? {
        ...patch.conversationConfig,
        compressionProviderId: patch.conversationConfig.compressionProviderId
          ? (providerIdMap.get(patch.conversationConfig.compressionProviderId) ??
            patch.conversationConfig.compressionProviderId)
          : undefined,
      }
    : undefined;
  if (
    conversationConfig?.compressionProviderId &&
    !effectiveProviders.some((provider) => provider.id === conversationConfig.compressionProviderId)
  ) {
    throw new AiConfigPatchError("The conversation compression Provider does not exist");
  }

  const updatedAiConfig: AiConfigStored = {
    enabled: patch.enabled,
    encryptedApiKey,
    baseURL: patch.baseURL,
    model: effectiveModel,
    providerFormat: patch.providerFormat,
    providers: providers ?? existingMigrated?.providers,
    activeProviderId: selectedProviderId,
    activeModelId,
    aiSelectionDisplayDefault:
      existingMigrated?.aiSelectionDisplayDefault ?? patch.aiSelectionDisplayDefault ?? "show",
    systemPrompt: patch.systemPrompt,
    behavioralPrompt: patch.behavioralPrompt,
    groupBehavioralPrompt: patch.groupBehavioralPrompt,
    triggerConfig: patch.triggerConfig,
    groupOverrides: patch.groupOverrides,
    conversationConfig,
    memoryConfig: patch.memoryConfig,
    stickerPacks: patch.stickerPacks ?? current?.stickerPacks,
    webToolsConfig: mergeWebToolsApiKeys(existingMigrated?.webToolsConfig, patch.webToolsConfig),
    imageGenerationReceiptConfig:
      patch.imageGenerationReceiptConfig === undefined
        ? existingMigrated?.imageGenerationReceiptConfig
        : resolveImageGenerationReceiptConfig(patch.imageGenerationReceiptConfig),
    agentToolsConfig: patch.agentToolsConfig,
    githubToolsConfig,
    artworkToolsConfig: patch.artworkToolsConfig,
    botMemoryConfig: patch.botMemoryConfig,
    messageConfig: patch.messageConfig,
    executionConfig:
      patch.executionConfig ?? existingMigrated?.executionConfig ?? DEFAULT_AI_EXECUTION_CONFIG,
    timeoutConfig:
      patch.timeoutConfig?.pixaiTaskMs === undefined
        ? patch.timeoutConfig
        : {
            ...patch.timeoutConfig,
            pixaiTaskMs: resolvePixaiTaskTimeoutMs(patch.timeoutConfig.pixaiTaskMs),
          },
    models: patch.models,
    modelCommandAccess: patch.modelCommandAccess,
    embeddingConfig,
    dataFilesConfig: patch.dataFilesConfig ?? current?.dataFilesConfig,
    privateChatAccess: patch.privateChatAccess ?? current?.privateChatAccess ?? "all",
    privateChatWhitelist: patch.privateChatWhitelist,
    mcpServerIds: patch.mcpServerIds,
    summaryConfig: patch.summaryConfig ?? current?.summaryConfig,
    imageOcrConfig,
    skillConfig: existingMigrated?.skillConfig,
  };

  return updatedAiConfig;
}
