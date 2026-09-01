import type { WebToolsConfig, WebToolsConfigPublic } from "@cos-tool-bot/shared";

export function toWebToolsConfigPublic(
  config: WebToolsConfig | undefined,
): WebToolsConfigPublic | undefined {
  if (!config) return undefined;

  return {
    enabled: config.enabled,
    trustedPrivateHosts: config.trustedPrivateHosts,
    search: config.search
      ? {
          provider: config.search.provider,
          hasApiKey: !!config.search.apiKey,
          baseURL: config.search.baseURL,
        }
      : undefined,
    imageGeneration: config.imageGeneration
      ? {
          provider: config.imageGeneration.provider,
          hasApiKey: !!config.imageGeneration.apiKey,
          baseURL: config.imageGeneration.baseURL,
          model: config.imageGeneration.model,
          size: config.imageGeneration.size,
          pixaiConfig: config.imageGeneration.pixaiConfig,
        }
      : undefined,
  };
}

export function mergeWebToolsApiKeys(
  current: WebToolsConfig | undefined,
  incoming: WebToolsConfig | undefined,
): WebToolsConfig | undefined {
  if (!incoming) return undefined;

  return {
    ...incoming,
    search: incoming.search
      ? {
          ...incoming.search,
          apiKey:
            incoming.search.apiKey !== undefined && incoming.search.apiKey !== ""
              ? incoming.search.apiKey
              : current?.search?.apiKey,
        }
      : undefined,
    imageGeneration: incoming.imageGeneration
      ? {
          ...incoming.imageGeneration,
          apiKey:
            incoming.imageGeneration.apiKey !== undefined && incoming.imageGeneration.apiKey !== ""
              ? incoming.imageGeneration.apiKey
              : current?.imageGeneration?.apiKey,
        }
      : undefined,
  };
}
