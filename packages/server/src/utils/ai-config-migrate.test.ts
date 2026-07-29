import type { AiConfigStored } from "@cos-tool-bot/shared";
import { DEFAULT_AI_EXECUTION_CONFIG, DEFAULT_CONVERSATION_CONFIG } from "@cos-tool-bot/shared";
import { describe, expect, it } from "vitest";
import { migrateAiConfig } from "./ai-config-migrate.js";

function createStoredConfig(): AiConfigStored {
  return {
    enabled: true,
    encryptedApiKey: null,
    baseURL: "https://example.com/v1",
    model: "test-model",
    providers: [
      {
        id: "provider-1",
        label: "Provider",
        encryptedApiKey: null,
        baseURL: "https://example.com/v1",
        providerFormat: "openai",
        defaultModel: "test-model",
      },
    ],
    activeProviderId: "provider-1",
    systemPrompt: "You are helpful",
    triggerConfig: {
      replyToBot: true,
      mentionBot: true,
      triggerWords: [],
      randomReplyPercent: 0,
      randomReplyCooldown: 0,
    },
    groupOverrides: {},
  };
}

describe("migrateAiConfig", () => {
  it("keeps global model selection separate from the Provider catalog default", () => {
    const stored = createStoredConfig();
    stored.activeProviderId = "provider-1";
    stored.activeModelId = "model-2";
    stored.providers = [
      {
        id: "provider-1",
        label: "Provider",
        encryptedApiKey: null,
        baseURL: "https://example.invalid",
        providerFormat: "openai",
        defaultModel: "model-1",
        models: [{ id: "model-1" }, { id: "model-2" }],
      },
    ];

    const migrated = migrateAiConfig(stored);
    expect(migrated.activeModelId).toBe("model-2");
    expect(migrated.providers?.[0]?.defaultModel).toBe("model-1");
    expect(migrated.aiSelectionDisplayDefault).toBe("show");
  });
  it("adds the raw-history limit to configurations saved before the setting existed", () => {
    const migrated = migrateAiConfig(createStoredConfig());

    expect(migrated.conversationConfig).toEqual(DEFAULT_CONVERSATION_CONFIG);
  });

  it("adds the default execution settings to configurations saved before the setting existed", () => {
    const migrated = migrateAiConfig(createStoredConfig());

    expect(migrated.executionConfig).toEqual(DEFAULT_AI_EXECUTION_CONFIG);
  });

  it("preserves configured execution settings while filling nested legacy defaults", () => {
    const stored = createStoredConfig();
    stored.executionConfig = {
      maxConcurrentReplies: 8,
      queueNotice: { enabled: false, text: "稍后回复" },
    };

    const migrated = migrateAiConfig(stored);

    expect(migrated.executionConfig).toEqual({
      maxConcurrentReplies: 8,
      queueNotice: { enabled: false, text: "稍后回复" },
    });
  });

  it("adds a provider default model that is missing from its model catalog", () => {
    const stored = createStoredConfig();
    stored.providers![0]!.models = [
      {
        id: "other-model",
        thinking: "enabled",
        thinkingBudget: 128,
      },
    ];

    const migrated = migrateAiConfig(stored);

    expect(migrated.providers![0]!.models).toEqual([
      {
        id: "other-model",
        thinking: "enabled",
        thinkingBudget: 128,
      },
      { id: "test-model" },
    ]);
  });

  it("does not duplicate a default model already present in the catalog", () => {
    const stored = createStoredConfig();
    stored.providers![0]!.models = [{ id: "test-model", label: "Test" }];

    const migrated = migrateAiConfig(stored);

    expect(migrated.providers![0]!.models).toEqual([{ id: "test-model", label: "Test" }]);
  });

  it("uses the first catalog entry when an older provider has an empty default", () => {
    const stored = createStoredConfig();
    stored.providers![0]!.defaultModel = "";
    stored.providers![0]!.models = [{ id: "first-model" }, { id: "second-model" }];

    const migrated = migrateAiConfig(stored);

    expect(migrated.providers![0]!.defaultModel).toBe("first-model");
  });

  it("normalizes the legacy default model when wrapping flat configuration", () => {
    const stored = createStoredConfig();
    stored.providers = undefined;
    stored.activeProviderId = undefined;
    stored.models = [{ id: "other-model" }];

    const migrated = migrateAiConfig(stored);

    expect(migrated.providers).toEqual([
      expect.objectContaining({
        id: "__legacy__",
        modelDiscoveryPath: "/models",
        models: [{ id: "other-model" }, { id: "test-model" }],
      }),
    ]);
  });

  it("preserves legacy /models discovery for an older Gemini provider", () => {
    const stored = createStoredConfig();
    stored.providers![0]!.providerFormat = "gemini";

    const migrated = migrateAiConfig(stored);

    expect(migrated.providers![0]!.modelDiscoveryPath).toBe("/models");
  });

  it("preserves an explicitly disabled discovery path", () => {
    const stored = createStoredConfig();
    stored.providers![0]!.modelDiscoveryPath = "";

    const migrated = migrateAiConfig(stored);

    expect(migrated.providers![0]!.modelDiscoveryPath).toBe("");
  });

  it("trims and de-duplicates legacy model catalogs while preserving first metadata", () => {
    const stored = createStoredConfig();
    stored.providers![0]!.defaultModel = " test-model ";
    stored.providers![0]!.models = [
      { id: " test-model ", thinking: "enabled", thinkingBudget: 32 },
      { id: "test-model", label: "duplicate" },
      { id: " " },
      { id: "other-model" },
    ];

    const migrated = migrateAiConfig(stored);

    expect(migrated.providers![0]).toMatchObject({
      defaultModel: "test-model",
      models: [
        { id: "test-model", thinking: "enabled", thinkingBudget: 32 },
        { id: "other-model" },
      ],
    });
  });
});
