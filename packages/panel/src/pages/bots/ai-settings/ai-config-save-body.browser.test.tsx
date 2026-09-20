import { expect, test } from "vitest";
import { DEFAULT_ENGAGEMENT_POLICY } from "@cos-tool-bot/shared";
import { buildAiConfigSaveBody, type AiConfigSaveInput } from "./ai-config-save-body";
import { DEFAULT_CONFIG, DEFAULT_EXECUTION_CONFIG } from "./types";

function fixture(): AiConfigSaveInput {
  return {
    revision: "test",
    config: {
      ...DEFAULT_CONFIG,
      engagement: { ...DEFAULT_ENGAGEMENT_POLICY, hasApiKey: true },
      groupOverrides: {
        "-1": { chatId: -1, whitelisted: true },
        "-2": { chatId: -2, whitelisted: true, engagement: { style: "filter" } },
      },
    },
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
}

test("explicitly resets inherited group policy while retaining custom overrides", () => {
  const body = buildAiConfigSaveBody(fixture());
  expect(body.groupOverrides["-1"]?.engagement).toBeNull();
  expect(body.groupOverrides["-2"]?.engagement).toEqual({ style: "filter" });
  expect(body.engagement?.apiKey).toBeUndefined();
});

test("saves a new key even before policy fields are edited without adding it to unrelated tools", () => {
  const input = fixture();
  input.config = { ...input.config, engagement: undefined, webToolsConfig: { enabled: false } };
  input.engagementApiKey = "test-new-key";
  const body = buildAiConfigSaveBody(input);
  expect(body.engagement).toMatchObject({ ...DEFAULT_ENGAGEMENT_POLICY, apiKey: "test-new-key" });
  expect(body.webToolsConfig).not.toHaveProperty("engagement");
});
