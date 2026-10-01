import type { AiProviderEntryPublic } from "@cos-tool-bot/shared";
import { expect, test } from "vitest";
import { mergeDiscoveredModels, replaceProviderModels } from "./model-discovery";
import { buildAiConfigSaveBody, type AiConfigSaveInput } from "./ai-config-save-body";
import { DEFAULT_CONFIG, DEFAULT_EXECUTION_CONFIG } from "./types";

const provider: AiProviderEntryPublic = {
  id: "provider",
  label: "Provider",
  hasApiKey: true,
  baseURL: "https://provider.example/v1",
  providerFormat: "openai",
  defaultModel: "kept",
  models: [
    { id: "kept", label: "Custom", temperature: 0.7, capabilities: ["vision"] },
    { id: "manual" },
  ],
  excludedModelIds: ["removed"],
};

test("merges new unique IDs while preserving overrides, manual models, exclusions and the default", () => {
  const updated = mergeDiscoveredModels(provider, [
    { id: "kept", capabilities: [] },
    { id: "removed" },
    { id: "new", capabilities: ["reasoning"] },
    { id: "new", capabilities: [] },
  ]);
  expect(updated.models).toEqual([...provider.models!, { id: "new", capabilities: ["reasoning"] }]);
  expect(updated.defaultModel).toBe("kept");
  expect(mergeDiscoveredModels(provider, [])).toBe(provider);
});

test("keeps removed models excluded until explicitly restored, scoped to each provider", () => {
  const removed = replaceProviderModels(provider, [provider.models![0]!]);
  const discovered = [{ id: "manual" }, { id: "removed" }];
  expect(mergeDiscoveredModels(removed, discovered).models).toEqual([provider.models![0]!]);
  expect(
    mergeDiscoveredModels({ ...removed, id: "other", excludedModelIds: [] }, discovered).models,
  ).toHaveLength(3);
  const restored = replaceProviderModels(removed, [...removed.models!, { id: "removed" }]);
  expect(restored.excludedModelIds).toEqual(["manual"]);
});

test("chooses the first allowed discovered model only when a provider has no default", () => {
  const updated = mergeDiscoveredModels({ ...provider, models: [], defaultModel: "" }, [
    { id: "removed" },
    { id: "new" },
  ]);
  expect(updated.defaultModel).toBe("new");
});

test("includes exclusions in the actual settings save payload", () => {
  const input: AiConfigSaveInput = {
    revision: "revision-1",
    config: { ...DEFAULT_CONFIG, providers: [provider] },
    triggerWordsText: "",
    stickerPacksText: "",
    summaryConfig: {
      enabled: false,
      defaultWindowHours: 24,
      defaultMaxMessages: 2000,
      defaultCooldownSeconds: 300,
    },
    imageOcrConfig: { enabled: false },
    executionConfig: DEFAULT_EXECUTION_CONFIG,
    providerApiKeys: {},
    webSearchApiKey: "",
    webImageApiKey: "",
    embeddingApiKey: "",
  };
  expect(buildAiConfigSaveBody(input).providers?.[0]?.excludedModelIds).toEqual(["removed"]);
});
