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
