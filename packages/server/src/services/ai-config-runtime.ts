import type { AiProviderRuntime } from "@cos-tool-bot/bot";
import type {
  AiConfigStored,
  AiGroupOverride,
  MessageConfig,
  TimeoutConfig,
} from "@cos-tool-bot/shared";
import { DEFAULT_MESSAGE_CONFIG } from "@cos-tool-bot/shared";
import { migrateAiConfig } from "../utils/ai-config-migrate.js";
import { tryDecrypt } from "../utils/crypto.js";
import { resolvePixaiTaskTimeoutMs } from "./generation-recovery.js";

export interface AiConfigRuntimeSkippedProviders {
  noKey: string[];
  decryptFailed: string[];
}

export interface AiConfigRuntime {
  /** Stored config after migrateAiConfig. */
  config: AiConfigStored;
  /** pixaiTaskMs is already resolved; undefined when the stored config has no timeoutConfig. */
  timeoutConfig: TimeoutConfig | undefined;
  providers: AiProviderRuntime[];
  activeProvider: AiProviderRuntime | undefined;
  skippedProviders: AiConfigRuntimeSkippedProviders;
  /** Decrypted legacy GitHub token; undefined when absent or undecryptable. */
  githubToken: string | undefined;
  githubTokenDecryptFailed: boolean;
  /** Decrypted embedding key when embedding is enabled and a ciphertext exists. */
  embeddingApiKey: string | undefined;
  embeddingApiKeyDecryptFailed: boolean;
}

/** Projects a stored AI config into the decrypted runtime view used to boot a bot. */
export function toAiConfigRuntime(
  stored: AiConfigStored | null | undefined,
  encryptionKey: string,
): AiConfigRuntime | null {
  if (!stored) return null;
  const config = migrateAiConfig(stored);
  const timeoutConfig = config.timeoutConfig
    ? {
        ...config.timeoutConfig,
        pixaiTaskMs: resolvePixaiTaskTimeoutMs(config.timeoutConfig.pixaiTaskMs),
      }
    : undefined;

  // Decrypt all providers up front — kept in-memory for bot lifetime.
  // Track skip reasons separately so operators can distinguish "no key configured"
  // from "encryption key mismatch" when diagnosing.
  const providers: AiProviderRuntime[] = [];
  const noKey: string[] = [];
  const decryptFailed: string[] = [];
  for (const p of config.providers ?? []) {
    if (!p.encryptedApiKey) {
      noKey.push(p.label);
      continue;
    }
    const decrypted = tryDecrypt(p.encryptedApiKey, encryptionKey);
    if (!decrypted) {
      decryptFailed.push(p.label);
      continue;
    }
    providers.push({
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
    (config.activeProviderId && providers.find((p) => p.id === config.activeProviderId)) ||
    providers[0];

  const encryptedGitHubToken = config.githubToolsConfig?.encryptedToken;
  const githubToken = encryptedGitHubToken
    ? (tryDecrypt(encryptedGitHubToken, encryptionKey) ?? undefined)
    : undefined;

  const embeddingCfg = config.embeddingConfig;
  const embeddingApiKey =
    embeddingCfg?.enabled && embeddingCfg.encryptedApiKey
      ? (tryDecrypt(embeddingCfg.encryptedApiKey, encryptionKey) ?? undefined)
      : undefined;

  return {
    config,
    timeoutConfig,
    providers,
    activeProvider,
    skippedProviders: { noKey, decryptFailed },
    githubToken,
    githubTokenDecryptFailed: Boolean(encryptedGitHubToken) && !githubToken,
    embeddingApiKey,
    embeddingApiKeyDecryptFailed: Boolean(
      embeddingCfg?.enabled && embeddingCfg.encryptedApiKey && !embeddingApiKey,
    ),
  };
}

export class AiConfigWriteBackError extends Error {}

export function applyGroupOverride(
  config: AiConfigStored,
  chatId: number,
  override: AiGroupOverride,
): AiConfigStored {
  return {
    ...config,
    groupOverrides: {
      ...config.groupOverrides,
      [String(chatId)]: override,
    },
  };
}

export function applyMessageConfigUpdate(
  config: AiConfigStored,
  updates: Partial<MessageConfig>,
): AiConfigStored {
  return {
    ...config,
    messageConfig: {
      ...DEFAULT_MESSAGE_CONFIG,
      ...config.messageConfig,
      ...updates,
    },
  };
}

export function applyWebToolApiKey(
  config: AiConfigStored,
  target: "image" | "search",
  apiKey: string,
): AiConfigStored {
  const webToolsConfig = config.webToolsConfig;
  if (!webToolsConfig) {
    throw new AiConfigWriteBackError("Web tools are not configured");
  }
  if (target === "image") {
    const targetConfig = webToolsConfig.imageGeneration;
    if (!targetConfig) {
      throw new AiConfigWriteBackError(`${target} web tool is not configured`);
    }
    return {
      ...config,
      webToolsConfig: { ...webToolsConfig, imageGeneration: { ...targetConfig, apiKey } },
    };
  }
  const targetConfig = webToolsConfig.search;
  if (!targetConfig) {
    throw new AiConfigWriteBackError(`${target} web tool is not configured`);
  }
  return {
    ...config,
    webToolsConfig: { ...webToolsConfig, search: { ...targetConfig, apiKey } },
  };
}
