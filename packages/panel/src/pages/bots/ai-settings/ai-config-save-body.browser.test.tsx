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

test("sends a typed web tool key only to its own tool and never echoes key indicators", () => {
  const input = fixture();
  input.config = {
    ...input.config,
    webToolsConfig: {
      enabled: true,
      search: { provider: "brave", hasApiKey: true, baseURL: "https://search.example.com" },
      imageGeneration: { provider: "openai", hasApiKey: false, model: "gpt-image-1" },
    },
  };
  input.webImageApiKey = "new-image-key";
  const body = buildAiConfigSaveBody(input);
  expect(body.webToolsConfig?.search).toEqual({
    provider: "brave",
    baseURL: "https://search.example.com",
  });
  expect(body.webToolsConfig?.imageGeneration).toMatchObject({
    provider: "openai",
    model: "gpt-image-1",
    apiKey: "new-image-key",
  });
  expect(JSON.stringify(body.webToolsConfig)).not.toContain("hasApiKey");
});

test("defaults unified search to enabled and retains an explicit false in the save body", () => {
  const input = fixture();
  expect(buildAiConfigSaveBody(input).unifiedSearchEnabled).toBe(true);
  input.config = { ...input.config, unifiedSearchEnabled: false };
  expect(buildAiConfigSaveBody(input).unifiedSearchEnabled).toBe(false);
  input.config = { ...input.config, unifiedSearchEnabled: true };
  expect(buildAiConfigSaveBody(input).unifiedSearchEnabled).toBe(true);
});

test("sends never-expiring and finite Issue confirmation policies in the save request", () => {
  const input = fixture();
  const github = {
    enabled: true,
    publicReadEnabled: true,
    codingAgentEnabled: false,
    hasToken: false,
    authorName: "Bot",
    authorEmail: "bot@example.test",
    repositories: ["owner/repo"],
  };
  input.config.githubToolsConfig = github;
  expect(
    buildAiConfigSaveBody(input).githubToolsConfig?.createIssueConfirmationTtlMinutes,
  ).toBeNull();
  input.config.githubToolsConfig = { ...github, createIssueConfirmationTtlMinutes: 60 };
  expect(buildAiConfigSaveBody(input).githubToolsConfig?.createIssueConfirmationTtlMinutes).toBe(
    60,
  );
  input.config.githubToolsConfig = { ...github, createIssueConfirmationTtlMinutes: null };
  expect(
    buildAiConfigSaveBody(input).githubToolsConfig?.createIssueConfirmationTtlMinutes,
  ).toBeNull();
});

test("saves recovery defaults and distinguishes inherited chat policy from disabled fallback", () => {
  const input = fixture();
  input.config.groupOverrides["-2"]!.modelRecovery = { maxRetries: 0, fallback: null };
  const body = buildAiConfigSaveBody(input);
  expect(body.modelRecovery).toEqual({ maxRetries: 1, fallback: null });
  expect(body.groupOverrides["-1"]?.modelRecovery).toBeNull();
  expect(body.groupOverrides["-2"]?.modelRecovery).toEqual({ maxRetries: 0, fallback: null });
});
