import {
  DEFAULT_AI_EXECUTION_CONFIG,
  type AiConfigPublic,
  type ImageOcrConfig,
  type SummaryConfigStored,
} from "@cos-tool-bot/shared";
import { expect, test, vi } from "vitest";
import {
  recoverAiConfigAfterApplyFailure,
  renameProviderModelReferences,
  resolveManagedProviderIdAfterSave,
} from "./utils";

const summaryConfig: SummaryConfigStored = {
  enabled: true,
  defaultWindowHours: 24,
  defaultMaxMessages: 2000,
  defaultCooldownSeconds: 300,
  modelId: "old-model",
};

function config(activeProviderId = "provider-a"): AiConfigPublic {
  return {
    enabled: true,
    hasApiKey: true,
    baseURL: "https://a.example/v1",
    model: "old-model",
    providers: [
      {
        id: "provider-a",
        label: "Provider A",
        hasApiKey: true,
        baseURL: "https://a.example/v1",
        providerFormat: "openai",
        defaultModel: "old-model",
        models: [{ id: "old-model" }, { id: "other-model" }],
      },
      {
        id: "provider-b",
        label: "Provider B",
        hasApiKey: true,
        baseURL: "https://b.example/v1",
        providerFormat: "openai",
        defaultModel: "old-model",
        models: [{ id: "old-model" }],
      },
    ],
    activeProviderId,
    systemPrompt: "",
    triggerConfig: {
      replyToBot: true,
      mentionBot: true,
      triggerWords: [],
      randomReplyPercent: 0,
      randomReplyCooldown: 60,
    },
    executionConfig: DEFAULT_AI_EXECUTION_CONFIG,
    groupOverrides: {},
    githubToolsConfig: {
      enabled: true,
      publicReadEnabled: true,
      codingAgentEnabled: true,
      codingProviderId: "provider-a",
      codingModelId: "old-model",
      hasToken: false,
      authorName: "AI",
      authorEmail: "ai@example.com",
      repositories: [],
    },
    agentToolsConfig: {
      enabled: true,
      subAgentModel: "old-model",
    },
  };
}

test("renames the provider model, default, and explicitly owned references", () => {
  const imageOcrConfig: ImageOcrConfig = {
    enabled: true,
    providerId: "provider-a",
    modelId: "old-model",
  };
  const renamed = renameProviderModelReferences({
    config: config(),
    summaryConfig,
    imageOcrConfig,
    providerId: "provider-a",
    currentId: "old-model",
    nextId: "new-model",
  });

  expect(renamed.config.providers[0]).toMatchObject({
    defaultModel: "new-model",
    models: [{ id: "new-model" }, { id: "other-model" }],
  });
  expect(renamed.config.providers[1]?.defaultModel).toBe("old-model");
  expect(renamed.config.githubToolsConfig?.codingModelId).toBe("new-model");
  expect(renamed.config.agentToolsConfig?.subAgentModel).toBe("new-model");
  expect(renamed.summaryConfig.modelId).toBe("new-model");
  expect(renamed.imageOcrConfig.modelId).toBe("new-model");
});

test("does not rename ambiguous global references for a non-active provider", () => {
  const currentConfig = config("provider-b");
  currentConfig.githubToolsConfig = {
    ...currentConfig.githubToolsConfig!,
    codingProviderId: "provider-b",
  };
  const imageOcrConfig: ImageOcrConfig = {
    enabled: true,
    providerId: "provider-b",
    modelId: "old-model",
  };
  const renamed = renameProviderModelReferences({
    config: currentConfig,
    summaryConfig,
    imageOcrConfig,
    providerId: "provider-a",
    currentId: "old-model",
    nextId: "new-model",
  });

  expect(renamed.config.providers[0]?.defaultModel).toBe("new-model");
  expect(renamed.config.githubToolsConfig?.codingModelId).toBe("old-model");
  expect(renamed.config.agentToolsConfig?.subAgentModel).toBe("old-model");
  expect(renamed.summaryConfig.modelId).toBe("old-model");
  expect(renamed.imageOcrConfig.modelId).toBe("old-model");
});

test("remaps the managed provider by save order even when provider metadata is identical", () => {
  const savedProviders = config().providers.map((provider, index) => ({
    ...provider,
    id: `saved-${index}`,
    label: "Duplicate",
    baseURL: "https://same.example/v1",
  }));

  expect(
    resolveManagedProviderIdAfterSave({
      currentProviderId: "__new_second",
      draftProviderIds: ["__new_first", "__new_second"],
      savedProviders,
      activeProviderId: "saved-0",
    }),
  ).toBe("saved-1");
});

test("keeps a managed provider selected when it was already persisted", () => {
  expect(
    resolveManagedProviderIdAfterSave({
      currentProviderId: "provider-b",
      draftProviderIds: ["provider-a", "provider-b"],
      savedProviders: config().providers,
      activeProviderId: "provider-a",
    }),
  ).toBe("provider-b");
});

test("reloads authoritative config after a saved config could not be applied", async () => {
  const reload = vi.fn().mockResolvedValue(true);

  await expect(
    recoverAiConfigAfterApplyFailure({ status: 503, code: "saved_apply_failed" }, reload),
  ).resolves.toBe("reloaded");
  expect(reload).toHaveBeenCalledOnce();
});

test("does not reload config for ordinary save failures", async () => {
  const reload = vi.fn().mockResolvedValue(true);

  await expect(recoverAiConfigAfterApplyFailure({ status: 409 }, reload)).resolves.toBe(
    "not-applicable",
  );
  expect(reload).not.toHaveBeenCalled();
});

test("does not reload config for an unclassified 503 response", async () => {
  const reload = vi.fn().mockResolvedValue(true);

  await expect(recoverAiConfigAfterApplyFailure({ status: 503 }, reload)).resolves.toBe(
    "not-applicable",
  );
  expect(reload).not.toHaveBeenCalled();
});

test("reports when authoritative config cannot be reloaded", async () => {
  await expect(
    recoverAiConfigAfterApplyFailure(
      { status: 503, code: "saved_apply_failed" },
      async () => false,
    ),
  ).resolves.toBe("reload-failed");
  await expect(
    recoverAiConfigAfterApplyFailure({ status: 503, code: "saved_apply_failed" }, async () => {
      throw new Error("network unavailable");
    }),
  ).resolves.toBe("reload-failed");
});
