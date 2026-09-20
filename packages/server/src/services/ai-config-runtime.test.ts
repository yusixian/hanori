import type { AiConfigStored, AiGroupOverride } from "@cos-tool-bot/shared";
import { DEFAULT_MESSAGE_CONFIG } from "@cos-tool-bot/shared";
import { describe, expect, it } from "vitest";
import { encrypt } from "../utils/crypto.js";
import {
  AiConfigWriteBackError,
  applyGroupOverride,
  applyMessageConfigUpdate,
  applyWebToolApiKey,
  toAiConfigRuntime,
} from "./ai-config-runtime.js";

const KEY = "runtime-test-key";
const OTHER_KEY = "another-test-key";

function baseConfig(overrides: Partial<AiConfigStored> = {}): AiConfigStored {
  return {
    enabled: true,
    encryptedApiKey: null,
    baseURL: "https://legacy.example.com/v1",
    model: "legacy-model",
    systemPrompt: "prompt",
    triggerConfig: {
      replyToBot: true,
      mentionBot: true,
      triggerWords: [],
      randomReplyPercent: 0,
      randomReplyCooldown: 0,
    },
    groupOverrides: {},
    ...overrides,
  };
}

function provider(id: string, label: string, encryptedApiKey: string | null) {
  return {
    id,
    label,
    encryptedApiKey,
    baseURL: `https://${id}.example.com/v1`,
    providerFormat: "openai" as const,
    defaultModel: `${id}-model`,
  };
}

describe("toAiConfigRuntime providers", () => {
  const providers = [
    provider("no-key", "No Key", null),
    provider("good", "Good", encrypt("good-secret", KEY)),
    provider("stale", "Stale", encrypt("stale-secret", OTHER_KEY)),
  ];

  it("returns null when no config is stored", () => {
    expect(toAiConfigRuntime(null, KEY)).toBeNull();
    expect(toAiConfigRuntime(undefined, KEY)).toBeNull();
  });

  it("keeps decryptable providers and reports each skip reason", () => {
    const runtime = toAiConfigRuntime(baseConfig({ providers }), KEY);

    expect(runtime?.providers.map((p) => p.id)).toEqual(["good"]);
    expect(runtime?.providers[0]?.apiKey).toBe("good-secret");
    expect(runtime?.skippedProviders).toEqual({
      noKey: ["No Key"],
      decryptFailed: ["Stale"],
    });
  });

  it("falls back to the first usable provider when the active one was skipped", () => {
    const runtime = toAiConfigRuntime(baseConfig({ providers, activeProviderId: "stale" }), KEY);

    expect(runtime?.activeProvider?.id).toBe("good");
  });

  it("selects the active provider when it is usable", () => {
    const second = provider("second", "Second", encrypt("second-secret", KEY));
    const runtime = toAiConfigRuntime(
      baseConfig({ providers: [...providers, second], activeProviderId: "second" }),
      KEY,
    );

    expect(runtime?.activeProvider?.id).toBe("second");
  });

  it("builds one runtime provider from a legacy flat config", () => {
    const runtime = toAiConfigRuntime(
      baseConfig({ encryptedApiKey: encrypt("legacy-secret", KEY) }),
      KEY,
    );

    expect(runtime?.providers).toHaveLength(1);
    expect(runtime?.providers[0]).toMatchObject({
      label: "Default",
      apiKey: "legacy-secret",
      baseURL: "https://legacy.example.com/v1",
      defaultModel: "legacy-model",
      providerFormat: "openai",
    });
    expect(runtime?.activeProvider?.id).toBe(runtime?.providers[0]?.id);
  });
});

describe("toAiConfigRuntime timeouts", () => {
  it("resolves the pixai task timeout", () => {
    const runtime = toAiConfigRuntime(
      baseConfig({ timeoutConfig: { perStepMs: 1234, pixaiTaskMs: 10 } }),
      KEY,
    );

    expect(runtime?.timeoutConfig?.perStepMs).toBe(1234);
    expect(runtime?.timeoutConfig?.pixaiTaskMs).toBe(1_000);
  });

  it("returns no timeout config when none is stored", () => {
    expect(toAiConfigRuntime(baseConfig(), KEY)?.timeoutConfig).toBeUndefined();
  });
});

describe("toAiConfigRuntime GitHub token", () => {
  function githubConfig(encryptedToken: string) {
    return {
      enabled: true,
      publicReadEnabled: true,
      codingAgentEnabled: false,
      encryptedToken,
      authorName: "bot",
      authorEmail: "bot@example.com",
      repositories: [],
    };
  }

  it("decrypts the legacy token", () => {
    const runtime = toAiConfigRuntime(
      baseConfig({ githubToolsConfig: githubConfig(encrypt("gh-token", KEY)) }),
      KEY,
    );

    expect(runtime?.githubToken).toBe("gh-token");
    expect(runtime?.githubTokenDecryptFailed).toBe(false);
  });

  it("reports a token that cannot be decrypted", () => {
    const runtime = toAiConfigRuntime(
      baseConfig({ githubToolsConfig: githubConfig(encrypt("gh-token", OTHER_KEY)) }),
      KEY,
    );

    expect(runtime?.githubToken).toBeUndefined();
    expect(runtime?.githubTokenDecryptFailed).toBe(true);
  });
});

describe("toAiConfigRuntime embedding key", () => {
  function embeddingConfig(enabled: boolean, encryptedApiKey: string) {
    return {
      enabled,
      encryptedApiKey,
      baseURL: "https://embed.example.com/v1",
      model: "embed-model",
      dimensions: 1536,
    };
  }

  it("decrypts the embedding key when embedding is enabled", () => {
    const runtime = toAiConfigRuntime(
      baseConfig({ embeddingConfig: embeddingConfig(true, encrypt("embed-secret", KEY)) }),
      KEY,
    );

    expect(runtime?.embeddingApiKey).toBe("embed-secret");
    expect(runtime?.embeddingApiKeyDecryptFailed).toBe(false);
  });

  it("reports an embedding key that cannot be decrypted", () => {
    const runtime = toAiConfigRuntime(
      baseConfig({ embeddingConfig: embeddingConfig(true, encrypt("embed-secret", OTHER_KEY)) }),
      KEY,
    );

    expect(runtime?.embeddingApiKey).toBeUndefined();
    expect(runtime?.embeddingApiKeyDecryptFailed).toBe(true);
  });

  it("ignores a disabled embedding config", () => {
    const runtime = toAiConfigRuntime(
      baseConfig({ embeddingConfig: embeddingConfig(false, encrypt("embed-secret", KEY)) }),
      KEY,
    );

    expect(runtime?.embeddingApiKey).toBeUndefined();
    expect(runtime?.embeddingApiKeyDecryptFailed).toBe(false);
  });
});

describe("toAiConfigRuntime engagement key", () => {
  const policy = {
    mode: "shadow" as const,
    style: "natural" as const,
    preferences: "join art discussions",
    keywordDirect: false,
    cooldownSeconds: 60,
    confidenceThreshold: 0.8,
    contextMessages: 20,
    timeoutMs: 1_000,
  };

  it("decrypts the JEV key into the runtime-only projection", () => {
    const runtime = toAiConfigRuntime(
      baseConfig({
        engagement: { ...policy, encryptedApiKey: encrypt("jev-secret", KEY) },
      }),
      KEY,
    );

    expect(runtime?.engagement).toEqual({ ...policy, apiKey: "jev-secret" });
    expect(runtime?.engagementApiKeyDecryptFailed).toBe(false);
    expect(JSON.stringify(runtime?.config)).not.toContain("jev-secret");
  });

  it("reports a JEV key that cannot be decrypted without exposing ciphertext in runtime policy", () => {
    const runtime = toAiConfigRuntime(
      baseConfig({
        engagement: { ...policy, encryptedApiKey: encrypt("jev-secret", OTHER_KEY) },
      }),
      KEY,
    );

    expect(runtime?.engagement.apiKey).toBeUndefined();
    expect(runtime?.engagementApiKeyDecryptFailed).toBe(true);
    expect(runtime?.engagement).not.toHaveProperty("encryptedApiKey");
  });
});

describe("AI config write-back helpers", () => {
  const override: AiGroupOverride = { chatId: -100, whitelisted: true, enabled: true };

  it("adds a group override without changing the input", () => {
    const config = baseConfig({ groupOverrides: { "-1": { chatId: -1, whitelisted: false } } });
    const snapshot = structuredClone(config);

    const next = applyGroupOverride(config, -100, override);

    expect(next.groupOverrides).toEqual({
      "-1": { chatId: -1, whitelisted: false },
      "-100": override,
    });
    expect(config).toEqual(snapshot);
  });

  it("merges message config updates over the defaults", () => {
    const config = baseConfig({ messageConfig: { ...DEFAULT_MESSAGE_CONFIG } });
    const snapshot = structuredClone(config);

    const next = applyMessageConfigUpdate(config, { richMessageEnabled: true });

    expect(next.messageConfig).toEqual({ ...DEFAULT_MESSAGE_CONFIG, richMessageEnabled: true });
    expect(config).toEqual(snapshot);
  });

  it("replaces a web tool API key without changing the input", () => {
    const config = baseConfig({
      webToolsConfig: {
        enabled: true,
        search: { provider: "brave", apiKey: "old-search" },
        imageGeneration: { provider: "openai", apiKey: "old-image" },
      },
    });
    const snapshot = structuredClone(config);

    const withSearch = applyWebToolApiKey(config, "search", "new-search");
    const withImage = applyWebToolApiKey(config, "image", "new-image");

    expect(withSearch.webToolsConfig?.search?.apiKey).toBe("new-search");
    expect(withSearch.webToolsConfig?.imageGeneration?.apiKey).toBe("old-image");
    expect(withImage.webToolsConfig?.imageGeneration?.apiKey).toBe("new-image");
    expect(config).toEqual(snapshot);
  });

  it("rejects a write when web tools are not configured", () => {
    expect(() => applyWebToolApiKey(baseConfig(), "search", "key")).toThrow(
      new AiConfigWriteBackError("Web tools are not configured"),
    );
  });

  it("rejects a write when the target web tool is not configured", () => {
    const config = baseConfig({ webToolsConfig: { enabled: true } });

    expect(() => applyWebToolApiKey(config, "image", "key")).toThrow(
      new AiConfigWriteBackError("image web tool is not configured"),
    );
  });
});
