import { describe, expect, it } from "vitest";
import { createWebTools } from "../tools/web.js";
import { DEFAULT_MESSAGE_CONFIG } from "@cos-tool-bot/shared";
import {
  deriveToolPromptCapabilities,
  hasWebSearchProviderPrerequisites,
} from "./tool-capabilities.js";

describe("web search capability", () => {
  it.each(["tavily", "brave", "searxng", "custom"] as const)(
    "keeps %s preview availability aligned with the real factory",
    (provider) => {
      for (const configured of [false, true]) {
        const search = {
          provider,
          apiKey: configured ? "test-key" : undefined,
          baseURL: configured ? "https://search.example.com" : undefined,
        };
        const tools = createWebTools({ config: { enabled: true, search } });
        const preview = deriveToolPromptCapabilities({
          hasBotMemoryTool: false,
          webToolsConfig: {
            enabled: true,
            search: { provider, hasApiKey: configured, baseURL: search.baseURL },
          },
        });
        expect(!!tools.web_search).toBe(configured);
        expect(preview.has("web-search")).toBe(!!tools.web_search);
      }
    },
  );

  it("matches the runtime factory prerequisites", () => {
    expect(hasWebSearchProviderPrerequisites({ provider: "tavily", apiKey: "key" })).toBe(true);
    expect(hasWebSearchProviderPrerequisites({ provider: "tavily" })).toBe(false);
    expect(
      hasWebSearchProviderPrerequisites({ provider: "searxng", baseURL: "https://search.test" }),
    ).toBe(true);
    expect(hasWebSearchProviderPrerequisites({ provider: "searxng" })).toBe(false);

    expect(
      createWebTools({ config: { enabled: true, search: { provider: "brave" } } }).web_search,
    ).toBeUndefined();
  });

  it("accepts a redacted API key marker only for preview derivation", () => {
    const publicConfig = { provider: "brave" as const, hasApiKey: true };

    expect(hasWebSearchProviderPrerequisites(publicConfig)).toBe(false);
    expect(hasWebSearchProviderPrerequisites(publicConfig, true)).toBe(true);
  });
});

describe("tool prompt compatibility", () => {
  it("preserves configured image fallback even with an explicit false runtime flag", () => {
    const capabilities = deriveToolPromptCapabilities({
      hasBotMemoryTool: false,
      hasImageGeneration: false,
      webToolsConfig: { enabled: false, imageGeneration: { provider: "openai" } },
    });
    expect(capabilities.has("image-generation")).toBe(true);
    expect(capabilities.has("web")).toBe(false);
  });

  it("offers multi-message by default but omits it in stream mode", () => {
    expect(deriveToolPromptCapabilities({ hasBotMemoryTool: false }).has("multi-message")).toBe(
      true,
    );
    expect(
      deriveToolPromptCapabilities({
        hasBotMemoryTool: false,
        messageConfig: { ...DEFAULT_MESSAGE_CONFIG, replyMode: "stream" },
      }).has("multi-message"),
    ).toBe(false);
  });
});
