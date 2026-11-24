import { DEFAULT_CONVERSATION_CONFIG } from "@cos-tool-bot/shared";
import { describe, expect, it } from "vitest";
import { aiConfigSchema } from "./ai-config-schema.js";

const triggerConfig = {
  replyToBot: true,
  mentionBot: true,
  triggerWords: [],
  randomReplyPercent: 0,
  randomReplyCooldown: 60,
};

function parse(overrides: Record<string, unknown>) {
  return aiConfigSchema.safeParse({
    revision: "0",
    enabled: false,
    baseURL: "",
    model: "",
    systemPrompt: "",
    triggerConfig,
    groupOverrides: {},
    ...overrides,
  });
}

function override(fields: Record<string, unknown>) {
  return { groupOverrides: { "-1001": { chatId: -1001, whitelisted: false, ...fields } } };
}

describe("admin AI settings bounds", () => {
  it("stores legacy unbounded or fractional cooldowns clamped into the shared bounds", () => {
    const result = parse({
      triggerConfig: { ...triggerConfig, randomReplyCooldown: 90_000.4 },
      ...override({ triggerConfig: { randomReplyCooldown: 1.5 } }),
    });

    expect(result.success).toBe(true);
    expect(result.data?.triggerConfig.randomReplyCooldown).toBe(86_400);
    expect(result.data?.groupOverrides["-1001"]?.triggerConfig?.randomReplyCooldown).toBe(2);
  });

  it("rounds legacy decimal context sizes without widening their range", () => {
    const result = parse({
      conversationConfig: { ...DEFAULT_CONVERSATION_CONFIG, maxContextMessages: 12.4 },
      ...override({ maxContextMessages: 99.5 }),
    });

    expect(result.success).toBe(true);
    expect(result.data?.conversationConfig?.maxContextMessages).toBe(12);
    expect(result.data?.groupOverrides["-1001"]?.maxContextMessages).toBe(100);
  });

  it("keeps fractional random reply percentages", () => {
    const result = parse({ triggerConfig: { ...triggerConfig, randomReplyPercent: 0.5 } });

    expect(result.data?.triggerConfig.randomReplyPercent).toBe(0.5);
  });

  it.each([
    ["a negative cooldown", { triggerConfig: { ...triggerConfig, randomReplyCooldown: -1 } }],
    ["a percentage above 100", { triggerConfig: { ...triggerConfig, randomReplyPercent: 100.5 } }],
    [
      "a context size below 1",
      { conversationConfig: { ...DEFAULT_CONVERSATION_CONFIG, maxContextMessages: 0 } },
    ],
    [
      "a context size above 100",
      { conversationConfig: { ...DEFAULT_CONVERSATION_CONFIG, maxContextMessages: 150 } },
    ],
    ["a group context size above 100", override({ maxContextMessages: 150 })],
    ["a group history budget above 64k", override({ groupHistoryMaxTokens: 64_001 })],
    ["a fractional group history budget", override({ groupHistoryMaxTokens: 2_000.5 })],
  ])("rejects %s", (_label, overrides) => {
    expect(parse(overrides).success).toBe(false);
  });
});

describe("Issue creation confirmation TTL", () => {
  const githubToolsConfig = {
    enabled: true,
    publicReadEnabled: true,
    codingAgentEnabled: false,
    authorName: "Bot",
    authorEmail: "bot@example.test",
    repositories: ["owner/repo"],
  };
  it.each([null, 1, 60, 5_256_001, Number.MAX_SAFE_INTEGER])(
    "accepts never expiry or positive safe integer %s",
    (ttl) => {
      const result = parse({
        githubToolsConfig: { ...githubToolsConfig, createIssueConfirmationTtlMinutes: ttl },
      });
      expect(result.success).toBe(true);
      expect(result.data?.githubToolsConfig?.createIssueConfirmationTtlMinutes).toBe(ttl);
    },
  );
  it.each([0, -1, 0.5, Number.MAX_SAFE_INTEGER + 1, "60"])("rejects invalid TTL %s", (ttl) => {
    expect(
      parse({ githubToolsConfig: { ...githubToolsConfig, createIssueConfirmationTtlMinutes: ttl } })
        .success,
    ).toBe(false);
  });
});

describe("memory consolidation settings", () => {
  const memory = { enabled: true, maxMemories: 20, autoInjectMemories: true };
  it("round trips custom consolidation settings and accepts legacy settings", () => {
    const consolidation = {
      enabled: true,
      intervalHours: 12,
      maxCallsPerRun: 4,
      modelTimeoutSeconds: 300,
      retentionDays: 180,
      groupImpressions: true,
      providerId: "cheap-provider",
      modelId: "small",
    };
    expect(parse({ botMemoryConfig: memory }).success).toBe(true);
    expect(
      parse({ botMemoryConfig: { ...memory, consolidation } }).data?.botMemoryConfig?.consolidation,
    ).toEqual(consolidation);
  });
  it.each([
    { intervalHours: 0 },
    { maxCallsPerRun: 33 },
    { modelTimeoutSeconds: 9 },
    { modelTimeoutSeconds: 601 },
    { modelTimeoutSeconds: 20.5 },
    { retentionDays: -1 },
    { providerId: "   " },
  ])("rejects invalid limits or model settings %j", (consolidation) => {
    expect(parse({ botMemoryConfig: { ...memory, consolidation } }).success).toBe(false);
  });
});
