import type { WebToolsConfig } from "@cos-tool-bot/shared";
import { describe, expect, it } from "vitest";
import { mergeWebToolsApiKeys, toWebToolsConfigPublic } from "./ai-config-web-tools.js";

const storedConfig: WebToolsConfig = {
  enabled: true,
  trustedPrivateHosts: ["localhost", "*.home.arpa"],
  search: {
    provider: "brave",
    apiKey: "search-secret",
    baseURL: "https://search.example.com",
  },
  imageGeneration: {
    provider: "pixai",
    apiKey: "rotated-image-secret",
    model: "model-id",
  },
};

describe("web tool API key config", () => {
  it("returns configured indicators without exposing plaintext API keys", () => {
    const publicConfig = toWebToolsConfigPublic(storedConfig);

    expect(publicConfig).toEqual({
      enabled: true,
      trustedPrivateHosts: ["localhost", "*.home.arpa"],
      search: {
        provider: "brave",
        hasApiKey: true,
        baseURL: "https://search.example.com",
      },
      imageGeneration: {
        provider: "pixai",
        hasApiKey: true,
        baseURL: undefined,
        model: "model-id",
        size: undefined,
        pixaiConfig: undefined,
      },
    });
    expect(publicConfig?.search).not.toHaveProperty("apiKey");
    expect(publicConfig?.imageGeneration).not.toHaveProperty("apiKey");
  });

  it("preserves freshly stored keys when a stale panel submits blank keys", () => {
    const merged = mergeWebToolsApiKeys(storedConfig, {
      enabled: false,
      search: { provider: "custom", apiKey: "", baseURL: "https://new-search.example.com" },
      imageGeneration: { provider: "pixai", model: "new-model" },
    });

    expect(merged?.search?.apiKey).toBe("search-secret");
    expect(merged?.imageGeneration?.apiKey).toBe("rotated-image-secret");
    expect(merged?.search?.baseURL).toBe("https://new-search.example.com");
    expect(merged?.imageGeneration?.model).toBe("new-model");
  });

  it("accepts explicit key replacements", () => {
    const merged = mergeWebToolsApiKeys(storedConfig, {
      enabled: true,
      search: { provider: "brave", apiKey: "new-search-secret" },
      imageGeneration: { provider: "openai", apiKey: "new-image-secret" },
    });

    expect(merged?.search?.apiKey).toBe("new-search-secret");
    expect(merged?.imageGeneration?.apiKey).toBe("new-image-secret");
  });
});
