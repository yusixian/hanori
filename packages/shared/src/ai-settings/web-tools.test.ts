import { describe, expect, it } from "vitest";
import type { WebToolsConfig } from "../types.js";
import {
  mergeWebToolsConfigUpdate,
  toWebToolsConfigPublic,
  toWebToolsConfigUpdate,
} from "./web-tools.js";

const stored: WebToolsConfig = {
  enabled: true,
  trustedPrivateHosts: ["localhost", "*.home.arpa"],
  search: {
    provider: "brave",
    apiKey: "search-secret",
    baseURL: "https://search.example.com",
  },
  imageGeneration: {
    provider: "pixai",
    apiKey: "image-secret",
    model: "model-id",
    size: "1024x1024",
    pixaiConfig: { samplingSteps: 20, apiMode: "rest" },
  },
};

function saveFromPanel(apiKeys: { search?: string; imageGeneration?: string }) {
  return mergeWebToolsConfigUpdate(
    stored,
    toWebToolsConfigUpdate(toWebToolsConfigPublic(stored), apiKeys),
  );
}

describe("web tools settings codec", () => {
  it("replaces stored API keys with configured indicators in the public view", () => {
    const publicConfig = toWebToolsConfigPublic(stored);

    expect(publicConfig).toEqual({
      enabled: true,
      trustedPrivateHosts: ["localhost", "*.home.arpa"],
      search: { provider: "brave", hasApiKey: true, baseURL: "https://search.example.com" },
      imageGeneration: {
        provider: "pixai",
        hasApiKey: true,
        model: "model-id",
        size: "1024x1024",
        pixaiConfig: { samplingSteps: 20, apiMode: "rest" },
      },
    });
    expect(JSON.stringify(publicConfig)).not.toMatch(/search-secret|image-secret|apiKey/);
    expect(
      toWebToolsConfigPublic({ enabled: true, search: { provider: "searxng" } })?.search,
    ).toMatchObject({ hasApiKey: false });
  });

  it("round-trips a panel save without retyped keys back to the stored config", () => {
    expect(saveFromPanel({ search: "", imageGeneration: "" })).toEqual(stored);
    expect(saveFromPanel({})).toEqual(stored);
  });

  it("keeps stored keys when a stale client submits blank keys", () => {
    const merged = mergeWebToolsConfigUpdate(stored, {
      enabled: false,
      search: { provider: "custom", apiKey: "", baseURL: "https://new-search.example.com" },
      imageGeneration: { provider: "pixai", model: "new-model" },
    });

    expect(merged?.search).toEqual({
      provider: "custom",
      apiKey: "search-secret",
      baseURL: "https://new-search.example.com",
    });
    expect(merged?.imageGeneration?.apiKey).toBe("image-secret");
    expect(merged?.imageGeneration?.model).toBe("new-model");
  });

  it("replaces only the key typed for each tool", () => {
    const update = toWebToolsConfigUpdate(toWebToolsConfigPublic(stored), {
      search: "new-search-secret",
    });

    expect(update?.search?.apiKey).toBe("new-search-secret");
    expect(update?.imageGeneration).not.toHaveProperty("hasApiKey");
    expect(update?.imageGeneration?.apiKey).toBeUndefined();
    const merged = mergeWebToolsConfigUpdate(stored, update);
    expect(merged?.search?.apiKey).toBe("new-search-secret");
    expect(merged?.imageGeneration?.apiKey).toBe("image-secret");
  });

  it("replaces both stored keys when the update supplies new ones", () => {
    const merged = mergeWebToolsConfigUpdate(stored, {
      enabled: true,
      search: { provider: "brave", apiKey: "new-search-secret" },
      imageGeneration: { provider: "openai", apiKey: "new-image-secret" },
    });

    expect(merged?.search?.apiKey).toBe("new-search-secret");
    expect(merged?.imageGeneration?.apiKey).toBe("new-image-secret");
  });

  it("drops a tool, and its key, when the update omits it", () => {
    const merged = mergeWebToolsConfigUpdate(stored, {
      enabled: true,
      imageGeneration: { provider: "openai" },
    });

    expect(merged?.search).toBeUndefined();
    expect(merged?.imageGeneration?.apiKey).toBe("image-secret");
    expect(mergeWebToolsConfigUpdate(stored, undefined)).toBeUndefined();
  });
});
