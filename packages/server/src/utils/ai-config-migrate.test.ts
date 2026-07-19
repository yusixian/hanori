import type { AiConfigStored } from "@cos-tool-bot/shared";
import { DEFAULT_CONVERSATION_CONFIG } from "@cos-tool-bot/shared";
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
  it("adds the raw-history limit to configurations saved before the setting existed", () => {
    const migrated = migrateAiConfig(createStoredConfig());

    expect(migrated.conversationConfig).toEqual(DEFAULT_CONVERSATION_CONFIG);
  });
});
