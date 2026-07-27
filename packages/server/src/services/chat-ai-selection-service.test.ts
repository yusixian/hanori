import type { Database } from "@cos-tool-bot/database";
import type { AiConfigStored } from "@cos-tool-bot/shared";
import { describe, expect, it, vi } from "vitest";
import { encrypt } from "../utils/crypto.js";
import {
  ChatAiSelectionError,
  ChatAiSelectionService,
  listUsableAiSelectionOptions,
  validateAiSelectionPair,
} from "./chat-ai-selection-service.js";
import { ChatAiSelectionRuntimeRegistry } from "./chat-ai-selection-runtime-registry.js";

const BOT_ID = "00000000-0000-4000-8000-000000000001";
const KEY = "test-encryption-key";

function config(): AiConfigStored {
  return {
    enabled: true,
    encryptedApiKey: null,
    baseURL: "",
    model: "a-default",
    providers: [
      {
        id: "provider-a",
        label: "Provider A",
        encryptedApiKey: encrypt("secret-a", KEY),
        baseURL: "https://a.invalid",
        providerFormat: "openai",
        defaultModel: "a-default",
        models: [{ id: "a-fast", label: "A Fast" }],
      },
      {
        id: "provider-b",
        label: "Provider B",
        encryptedApiKey: encrypt("secret-b", KEY),
        baseURL: "https://b.invalid",
        providerFormat: "openai",
        defaultModel: "b-default",
        models: [{ id: "b-fast" }],
      },
      {
        id: "broken",
        label: "Broken",
        encryptedApiKey: "not-ciphertext",
        baseURL: "https://broken.invalid",
        providerFormat: "openai",
        defaultModel: "broken-default",
      },
    ],
    activeProviderId: "provider-a",
    activeModelId: "a-fast",
    systemPrompt: "system",
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

describe("AI selection validation", () => {
  it("returns only credential-usable providers and safe catalog metadata", () => {
    const serialized = JSON.stringify(listUsableAiSelectionOptions(config(), KEY));
    expect(serialized).toContain("Provider A");
    expect(serialized).toContain("a-default");
    expect(serialized).not.toMatch(/secret-a|https:\/\/a\.invalid|not-ciphertext|Broken/);
  });

  it("rejects a model from another Provider", () => {
    const options = listUsableAiSelectionOptions(config(), KEY);
    expect(() =>
      validateAiSelectionPair(options, { providerId: "provider-a", modelId: "b-fast" }),
    ).toThrowError(
      expect.objectContaining<Partial<ChatAiSelectionError>>({ code: "model_unavailable" }),
    );
  });

  it("accepts null as the selected Provider default without inventing an arbitrary model", () => {
    const options = listUsableAiSelectionOptions(config(), KEY);
    expect(validateAiSelectionPair(options, { providerId: "provider-b", modelId: null })).toEqual({
      providerId: "provider-b",
      modelId: null,
    });
  });
});

describe("ChatAiSelectionService persistence boundary", () => {
  it("never publishes when the database transaction fails", async () => {
    const failure = new Error("database unavailable");
    const db = { transaction: vi.fn(async () => Promise.reject(failure)) } as unknown as Database;
    const runtime = new ChatAiSelectionRuntimeRegistry();
    const publish = vi.spyOn(runtime, "publish");
    const service = new ChatAiSelectionService(db, KEY, runtime, async (_botId, operation) =>
      operation(),
    );

    await expect(
      service.setChat({
        botId: BOT_ID,
        chatId: -1001,
        expectedRevision: "rev",
        pair: { providerId: "provider-a", modelId: "a-fast" },
        actor: { kind: "telegram_user", id: "42" },
      }),
    ).rejects.toBe(failure);
    expect(publish).not.toHaveBeenCalled();
  });
});
