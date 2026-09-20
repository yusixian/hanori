import { EMBEDDING_DIMENSIONS } from "@cos-tool-bot/database";
import { DEFAULT_AI_EXECUTION_CONFIG, DEFAULT_ENGAGEMENT_POLICY } from "@cos-tool-bot/shared";
import type { AiConfigStored } from "@cos-tool-bot/shared";
import { describe, expect, it } from "vitest";
import { hasActiveApiKey, toAiConfigPublic } from "./ai-config-public-view.js";

const baseStored: AiConfigStored = {
  enabled: true,
  encryptedApiKey: null,
  baseURL: "",
  model: "",
  systemPrompt: "be helpful",
  triggerConfig: {
    replyToBot: true,
    mentionBot: true,
    triggerWords: [],
    randomReplyPercent: 0,
    randomReplyCooldown: 60,
  },
  groupOverrides: {},
};

const secretStored: AiConfigStored = {
  ...baseStored,
  providers: [
    {
      id: "provider-1",
      label: "Main",
      encryptedApiKey: "iv1:tag1:provider-secret",
      baseURL: "https://api.example.com/v1",
      providerFormat: "openai",
      defaultModel: "model-a",
      models: [{ id: "model-a" }],
    },
  ],
  activeProviderId: "provider-1",
  activeModelId: "model-a",
  embeddingConfig: {
    enabled: true,
    encryptedApiKey: "iv2:tag2:embedding-secret",
    baseURL: "https://embeddings.example.com/v1",
    model: "embed-a",
    dimensions: EMBEDDING_DIMENSIONS,
  },
  githubToolsConfig: {
    enabled: true,
    publicReadEnabled: false,
    codingAgentEnabled: true,
    encryptedToken: "iv3:tag3:github-secret",
    githubAppInstallation: {
      installationId: 42,
      accountLogin: "installation-account",
      accountType: "Organization",
      repositorySelection: "selected",
      repositories: ["owner/repo"],
      permissions: { contents: "write" },
      connectedAt: "2026-01-01T00:00:00.000Z",
    },
    login: "legacy-login",
    authorName: "Bot",
    authorEmail: "bot@example.com",
    repositories: ["owner/repo"],
  },
  webToolsConfig: {
    enabled: true,
    search: { provider: "tavily", apiKey: "tavily-secret" },
    imageGeneration: { provider: "openai", apiKey: "openai-secret" },
  },
  engagement: {
    ...DEFAULT_ENGAGEMENT_POLICY,
    mode: "shadow",
    encryptedApiKey: "iv4:tag4:engagement-secret",
  },
};

describe("toAiConfigPublic", () => {
  it("returns the empty default view without a stored config", () => {
    expect(toAiConfigPublic(null)).toEqual({
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
      providers: [],
      executionConfig: DEFAULT_AI_EXECUTION_CONFIG,
    });
  });

  it("drops every secret while it keeps the presence flags", () => {
    const view = toAiConfigPublic(secretStored);
    const serialized = JSON.stringify(view);

    expect(serialized).not.toMatch(/encrypted/i);
    expect(serialized).not.toMatch(/"apiKey"/);
    expect(serialized).not.toContain("provider-secret");
    expect(serialized).not.toContain("embedding-secret");
    expect(serialized).not.toContain("github-secret");
    expect(serialized).not.toContain("tavily-secret");
    expect(serialized).not.toContain("openai-secret");
    expect(serialized).not.toContain("engagement-secret");

    expect(view.hasApiKey).toBe(true);
    expect(view.providers[0]!.hasApiKey).toBe(true);
    expect(view.embeddingConfig).toEqual({
      enabled: true,
      hasApiKey: true,
      baseURL: "https://embeddings.example.com/v1",
      model: "embed-a",
      dimensions: EMBEDDING_DIMENSIONS,
    });
    expect(view.githubToolsConfig?.hasToken).toBe(true);
    expect(view.webToolsConfig?.search?.hasApiKey).toBe(true);
    expect(view.webToolsConfig?.imageGeneration?.hasApiKey).toBe(true);
    expect(view.engagement).toEqual({
      ...DEFAULT_ENGAGEMENT_POLICY,
      mode: "shadow",
      hasApiKey: true,
    });
  });

  it("prefers the installation account login over the legacy login", () => {
    expect(toAiConfigPublic(secretStored).githubToolsConfig?.login).toBe("installation-account");

    const withoutInstallation: AiConfigStored = {
      ...secretStored,
      githubToolsConfig: {
        ...secretStored.githubToolsConfig!,
        githubAppInstallation: undefined,
      },
    };
    expect(toAiConfigPublic(withoutInstallation).githubToolsConfig?.login).toBe("legacy-login");
  });

  it("omits the optional sections when the stored config omits them", () => {
    const view = toAiConfigPublic(baseStored);
    expect(view.githubToolsConfig).toBeUndefined();
    expect(view.embeddingConfig).toBeUndefined();
    expect(view.webToolsConfig).toBeUndefined();
  });
});

describe("hasActiveApiKey", () => {
  it("reports false without a stored config", () => {
    expect(hasActiveApiKey(null)).toBe(false);
    expect(hasActiveApiKey(undefined)).toBe(false);
  });

  it("reads the legacy top-level key", () => {
    expect(
      hasActiveApiKey({
        ...baseStored,
        encryptedApiKey: "iv:tag:legacy-secret",
        baseURL: "https://api.example.com/v1",
        model: "model-a",
      }),
    ).toBe(true);
    expect(
      hasActiveApiKey({ ...baseStored, baseURL: "https://api.example.com/v1", model: "model-a" }),
    ).toBe(false);
  });

  it("reads the active provider key", () => {
    expect(hasActiveApiKey(secretStored)).toBe(true);
    expect(
      hasActiveApiKey({
        ...secretStored,
        providers: [{ ...secretStored.providers![0]!, encryptedApiKey: null }],
      }),
    ).toBe(false);
  });
});
