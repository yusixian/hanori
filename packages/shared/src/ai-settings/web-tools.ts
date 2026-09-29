import type { WebToolsConfig, WebToolsConfigPublic } from "../ai-tools.js";

type SearchSettings = Omit<NonNullable<WebToolsConfig["search"]>, "apiKey">;
type ImageGenerationSettings = Omit<NonNullable<WebToolsConfig["imageGeneration"]>, "apiKey">;

/** API keys for one save. A blank or missing key keeps the key already stored for that tool. */
export interface WebToolsApiKeyInput {
  search?: string;
  imageGeneration?: string;
}

function searchSettings(search: SearchSettings): SearchSettings {
  return { provider: search.provider, baseURL: search.baseURL };
}

function imageGenerationSettings(image: ImageGenerationSettings): ImageGenerationSettings {
  return {
    provider: image.provider,
    baseURL: image.baseURL,
    model: image.model,
    size: image.size,
    pixaiConfig: image.pixaiConfig,
  };
}

function suppliedApiKey(apiKey: string | undefined): string | undefined {
  return apiKey || undefined;
}

function withApiKeys(
  config: WebToolsConfig | WebToolsConfigPublic,
  apiKeys: WebToolsApiKeyInput,
): WebToolsConfig {
  return {
    enabled: config.enabled,
    trustedPrivateHosts: config.trustedPrivateHosts,
    search: config.search
      ? { ...searchSettings(config.search), apiKey: apiKeys.search }
      : undefined,
    imageGeneration: config.imageGeneration
      ? { ...imageGenerationSettings(config.imageGeneration), apiKey: apiKeys.imageGeneration }
      : undefined,
  };
}

export function toWebToolsConfigPublic(
  config: WebToolsConfig | undefined,
): WebToolsConfigPublic | undefined {
  if (!config) return undefined;
  return {
    enabled: config.enabled,
    trustedPrivateHosts: config.trustedPrivateHosts,
    search: config.search
      ? { ...searchSettings(config.search), hasApiKey: !!config.search.apiKey }
      : undefined,
    imageGeneration: config.imageGeneration
      ? {
          ...imageGenerationSettings(config.imageGeneration),
          hasApiKey: !!config.imageGeneration.apiKey,
        }
      : undefined,
  };
}

export function toWebToolsConfigUpdate(
  config: WebToolsConfigPublic | undefined,
  apiKeys: WebToolsApiKeyInput,
): WebToolsConfig | undefined {
  if (!config) return undefined;
  return withApiKeys(config, {
    search: suppliedApiKey(apiKeys.search),
    imageGeneration: suppliedApiKey(apiKeys.imageGeneration),
  });
}

/**
 * Applies an update to the stored config. A blank or missing key keeps the stored key; omitting a
 * tool, or the whole config, removes it together with its key.
 */
export function mergeWebToolsConfigUpdate(
  current: WebToolsConfig | undefined,
  update: WebToolsConfig | undefined,
): WebToolsConfig | undefined {
  if (!update) return undefined;
  return withApiKeys(update, {
    search: suppliedApiKey(update.search?.apiKey) ?? current?.search?.apiKey,
    imageGeneration:
      suppliedApiKey(update.imageGeneration?.apiKey) ?? current?.imageGeneration?.apiKey,
  });
}
