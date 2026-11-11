import type { AiConfigStored } from "@cos-tool-bot/shared";
import { DEFAULT_ENGAGEMENT_POLICY } from "@cos-tool-bot/shared";
import { describe, expect, it } from "vitest";
import { decrypt } from "../utils/crypto.js";
import { AiConfigPatchError, absorbAiConfigPatch } from "./ai-config-patch.js";
import { aiConfigSchema, type AiConfigPatch } from "./ai-config-schema.js";
import { toAiConfigPublic } from "./ai-config-public-view.js";

const ENCRYPTION_KEY = "test-key";
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function buildPatch(overrides: Record<string, unknown> = {}): AiConfigPatch {
  return aiConfigSchema.parse({
    revision: "0",
    enabled: true,
    baseURL: "",
    model: "",
    systemPrompt: "be helpful",
    triggerConfig: {
      replyToBot: true,
      mentionBot: true,
      triggerWords: [],
      randomReplyPercent: 0,
      randomReplyCooldown: 60,
    },
    groupOverrides: {},
    ...overrides,
  });
}

function absorb(current: AiConfigStored | null, patch: AiConfigPatch): AiConfigStored {
  return absorbAiConfigPatch({ current, patch, actorRole: "owner", encryptionKey: ENCRYPTION_KEY });
}

function expectPatchError(absorbCall: () => AiConfigStored, message: string) {
  expect(absorbCall).toThrow(AiConfigPatchError);
  expect(absorbCall).toThrow(message);
}

describe("unified search configuration", () => {
  it("defaults to unified search and preserves explicit rollback through older clients", () => {
    const enabled = absorb(null, buildPatch({ enabled: false }));
    expect(enabled.unifiedSearchEnabled).toBe(true);
    expect(toAiConfigPublic(enabled).unifiedSearchEnabled).toBe(true);
    const disabled = absorb(enabled, buildPatch({ enabled: false, unifiedSearchEnabled: false }));
    expect(disabled.unifiedSearchEnabled).toBe(false);
    expect(toAiConfigPublic(disabled).unifiedSearchEnabled).toBe(false);
    expect(absorb(disabled, buildPatch({ enabled: false })).unifiedSearchEnabled).toBe(false);
    expect(
      absorb(disabled, buildPatch({ enabled: false, unifiedSearchEnabled: true }))
        .unifiedSearchEnabled,
    ).toBe(true);
  });

  it("rejects a nonboolean switch value", () => {
    expect(() => buildPatch({ enabled: false, unifiedSearchEnabled: "false" })).toThrow();
  });
});

describe("engagement config validation", () => {
  it.each([
    ["addressedConfidenceThreshold", -0.1],
    ["addressedConfidenceThreshold", 1.1],
    ["continueConfidenceThreshold", -0.1],
    ["continueConfidenceThreshold", 1.1],
    ["continuationWindowSeconds", -1],
    ["continuationWindowSeconds", 301],
    ["continuationWindowSeconds", 1.5],
  ])("rejects invalid %s=%s for Bot defaults and group overrides", (key, value) => {
    expect(() =>
      buildPatch({ enabled: false, engagement: { ...DEFAULT_ENGAGEMENT_POLICY, [key]: value } }),
    ).toThrow();
    expect(() =>
      buildPatch({
        enabled: false,
        groupOverrides: {
          "-100": { chatId: -100, whitelisted: true, engagement: { [key]: value } },
        },
      }),
    ).toThrow();
  });

  it("accepts independent boundary thresholds and a disabled continuation window", () => {
    const policy = {
      ...DEFAULT_ENGAGEMENT_POLICY,
      addressedConfidenceThreshold: 0,
      continueConfidenceThreshold: 1,
      continuationWindowSeconds: 0,
    };
    expect(buildPatch({ enabled: false, engagement: policy }).engagement).toEqual(policy);
  });

  it("caps the evaluator context at the runtime-supported 20 messages", () => {
    expect(() =>
      buildPatch({
        engagement: {
          mode: "shadow",
          style: "natural",
          preferences: "",
          keywordDirect: false,
          cooldownSeconds: 60,
          confidenceThreshold: 0.8,
          contextMessages: 21,
          timeoutMs: 1_000,
        },
      }),
    ).toThrow();
  });
});

const storedProvider = {
  id: "provider-1",
  label: "Main",
  encryptedApiKey: null as string | null,
  baseURL: "https://api.example.com/v1",
  providerFormat: "openai" as const,
  defaultModel: "model-a",
  models: [{ id: "model-a" }],
};

function storedConfig(overrides: Partial<AiConfigStored> = {}): AiConfigStored {
  return {
    enabled: true,
    encryptedApiKey: null,
    baseURL: "",
    model: "",
    systemPrompt: "be helpful",
    triggerConfig: {
      replyToBot: true,
      mentionBot: true,
      triggerWords: [],
      randomReplyPercent: 0,
      randomReplyCooldown: 60,
    },
    groupOverrides: {},
    providers: [storedProvider],
    activeProviderId: "provider-1",
    activeModelId: "model-a",
    ...overrides,
  };
}

const patchProvider = {
  id: "provider-1",
  label: "Main",
  baseURL: "https://api.example.com/v1",
  providerFormat: "openai",
  defaultModel: "model-a",
  models: [{ id: "model-a" }],
};

describe("absorbAiConfigPatch provider keys", () => {
  it("round-trips model exclusions and preserves them for clients that omit the field", () => {
    const saved = absorb(
      storedConfig(),
      buildPatch({
        providers: [{ ...patchProvider, excludedModelIds: ["removed-model"] }],
      }),
    );
    expect(saved.providers![0]!.excludedModelIds).toEqual(["removed-model"]);
    expect(toAiConfigPublic(saved).providers[0]!.excludedModelIds).toEqual(["removed-model"]);
    const legacySave = absorb(saved, buildPatch({ providers: [patchProvider] }));
    expect(legacySave.providers![0]!.excludedModelIds).toEqual(["removed-model"]);
    const restored = absorb(
      saved,
      buildPatch({
        providers: [{ ...patchProvider, excludedModelIds: [] }],
      }),
    );
    expect(toAiConfigPublic(restored).providers[0]!.excludedModelIds).toEqual([]);
  });

  it("encrypts a newly supplied provider key", () => {
    const result = absorb(
      null,
      buildPatch({ providers: [{ ...patchProvider, id: undefined, apiKey: "fresh-key" }] }),
    );
    const encrypted = result.providers![0]!.encryptedApiKey!;
    expect(decrypt(encrypted, ENCRYPTION_KEY)).toBe("fresh-key");
  });

  it("keeps the stored ciphertext when the patch omits the key", () => {
    const current = storedConfig({
      providers: [{ ...storedProvider, encryptedApiKey: "iv:tag:stored" }],
    });
    const result = absorb(current, buildPatch({ providers: [{ ...patchProvider, apiKey: "" }] }));
    expect(result.providers![0]!.encryptedApiKey).toBe("iv:tag:stored");
  });

  it("rejects a base URL change on a keyed provider without a new key", () => {
    const current = storedConfig({
      providers: [{ ...storedProvider, encryptedApiKey: "iv:tag:stored" }],
    });
    expectPatchError(
      () =>
        absorb(
          current,
          buildPatch({
            providers: [{ ...patchProvider, baseURL: "https://other.example.com/v1", apiKey: "" }],
          }),
        ),
      'Provider "Main" requires a new API key when its base URL changes',
    );
  });
});

describe("absorbAiConfigPatch provider id remapping", () => {
  it("replaces temporary ids and rewrites every reference", () => {
    const result = absorb(
      null,
      buildPatch({
        providers: [{ ...patchProvider, id: "__new_1", apiKey: "fresh-key" }],
        activeProviderId: "__new_1",
        imageOcrConfig: { enabled: true, providerId: "__new_1", modelId: "model-a" },
        conversationConfig: {
          enabled: true,
          maxContextMessages: 10,
          groupBufferSize: 10,
          groupContextMode: "all",
          saveGroupContext: "all",
          autoSummarize: false,
          summarizeThreshold: 20,
          compressionProviderId: "__new_1",
          retentionDays: 30,
        },
        githubToolsConfig: {
          enabled: true,
          publicReadEnabled: false,
          codingAgentEnabled: true,
          codingProviderId: "__new_1",
          codingModelId: "model-a",
          authorName: "Bot",
          authorEmail: "bot@example.com",
          repositories: ["Owner/Repo"],
        },
      }),
    );

    const finalId = result.providers![0]!.id;
    expect(finalId).toMatch(UUID_PATTERN);
    expect(result.activeProviderId).toBe(finalId);
    expect(result.imageOcrConfig?.providerId).toBe(finalId);
    expect(result.conversationConfig?.compressionProviderId).toBe(finalId);
    expect(result.githubToolsConfig?.codingProviderId).toBe(finalId);
    expect(result.githubToolsConfig?.repositories).toEqual(["owner/repo"]);
  });

  it("rejects a compression provider that does not exist", () => {
    expectPatchError(
      () =>
        absorb(
          null,
          buildPatch({
            providers: [{ ...patchProvider, id: undefined, apiKey: "fresh-key" }],
            conversationConfig: {
              enabled: true,
              maxContextMessages: 10,
              groupBufferSize: 10,
              groupContextMode: "all",
              saveGroupContext: "all",
              autoSummarize: false,
              summarizeThreshold: 20,
              compressionProviderId: "missing-provider",
              retentionDays: 30,
            },
          }),
        ),
      "The conversation compression Provider does not exist",
    );
  });
});

describe("absorbAiConfigPatch active selection", () => {
  it("takes the requested pair on the first save", () => {
    const result = absorb(
      null,
      buildPatch({
        providers: [
          { ...patchProvider, apiKey: "fresh-key" },
          {
            ...patchProvider,
            id: "provider-2",
            label: "Spare",
            apiKey: "other-key",
            defaultModel: "model-b",
            models: [{ id: "model-b" }],
          },
        ],
        activeProviderId: "provider-2",
        activeModelId: "model-b",
      }),
    );
    expect(result.activeProviderId).toBe("provider-2");
    expect(result.activeModelId).toBe("model-b");
  });

  it("keeps the stored pair on a later save", () => {
    const current = storedConfig({
      providers: [
        { ...storedProvider, encryptedApiKey: "iv:tag:stored" },
        {
          ...storedProvider,
          id: "provider-2",
          label: "Spare",
          encryptedApiKey: "iv:tag:stored-2",
          defaultModel: "model-b",
          models: [{ id: "model-b" }],
        },
      ],
      activeProviderId: "provider-2",
      activeModelId: "model-b",
    });
    const result = absorb(
      current,
      buildPatch({
        providers: [
          { ...patchProvider, apiKey: "" },
          {
            ...patchProvider,
            id: "provider-2",
            label: "Spare",
            apiKey: "",
            defaultModel: "model-b",
            models: [{ id: "model-b" }],
          },
        ],
        activeProviderId: "provider-1",
        activeModelId: "model-a",
      }),
    );
    expect(result.activeProviderId).toBe("provider-2");
    expect(result.activeModelId).toBe("model-b");
  });

  it("rejects a model that the active provider does not offer", () => {
    expectPatchError(
      () =>
        absorb(
          null,
          buildPatch({
            providers: [{ ...patchProvider, apiKey: "fresh-key" }],
            activeProviderId: "provider-1",
            activeModelId: "model-z",
          }),
        ),
      "The selected model is not available for the active Provider",
    );
  });
});

describe("absorbAiConfigPatch embedding config", () => {
  it("keeps the stored ciphertext when the patch omits the key", () => {
    const current = storedConfig({
      embeddingConfig: {
        enabled: true,
        encryptedApiKey: "iv:tag:embedding",
        baseURL: "https://embeddings.example.com/v1",
        model: "embed-a",
        dimensions: 1536,
      },
    });
    const result = absorb(
      current,
      buildPatch({
        providers: [{ ...patchProvider, apiKey: "" }],
        embeddingConfig: {
          enabled: true,
          apiKey: "",
          baseURL: "https://embeddings.example.com/v1",
          model: "embed-a",
        },
      }),
    );
    expect(result.embeddingConfig?.encryptedApiKey).toBe("iv:tag:embedding");
  });

  it("encrypts a newly supplied embedding key", () => {
    const result = absorb(
      null,
      buildPatch({
        providers: [{ ...patchProvider, apiKey: "fresh-key" }],
        embeddingConfig: {
          enabled: true,
          apiKey: "embedding-key",
          baseURL: "https://embeddings.example.com/v1",
          model: "embed-a",
        },
      }),
    );
    expect(decrypt(result.embeddingConfig!.encryptedApiKey, ENCRYPTION_KEY)).toBe("embedding-key");
  });
});

describe("absorbAiConfigPatch preserved sections", () => {
  it("keeps the stored skill, execution and receipt sections when the patch omits them", () => {
    const current = storedConfig({
      skillConfig: { enabledBuiltInIds: ["md2tg"], customSkills: [] },
      executionConfig: { maxConcurrentReplies: 4, queueNotice: { enabled: false, text: "" } },
      imageGenerationReceiptConfig: {
        promptPreviewLength: 30,
        truncationNoticeEnabled: false,
        truncationNoticeText: "",
        albumNoticeEnabled: false,
        albumNoticeText: "",
      },
    });
    const result = absorb(current, buildPatch({ providers: [{ ...patchProvider, apiKey: "" }] }));

    expect(result.skillConfig).toEqual({ enabledBuiltInIds: ["md2tg"], customSkills: [] });
    expect(result.executionConfig).toEqual({
      maxConcurrentReplies: 4,
      timerMaxSeconds: 86_400,
      queueNotice: { enabled: false, text: "" },
    });
    expect(result.imageGenerationReceiptConfig?.promptPreviewLength).toBe(30);
  });

  it("preserves engagement secrets and group policies omitted by older settings clients", () => {
    const current = storedConfig({
      engagement: {
        ...DEFAULT_ENGAGEMENT_POLICY,
        mode: "shadow",
        style: "natural",
        preferences: "join art discussions",
        keywordDirect: false,
        cooldownSeconds: 60,
        confidenceThreshold: 0.8,
        contextMessages: 20,
        timeoutMs: 1_000,
        encryptedApiKey: "iv:tag:engagement",
      },
      groupOverrides: {
        "-100": {
          chatId: -100,
          whitelisted: true,
          engagement: { style: "assistant" },
        },
      },
    });
    const result = absorb(
      current,
      buildPatch({
        providers: [{ ...patchProvider, apiKey: "" }],
        groupOverrides: { "-100": { chatId: -100, whitelisted: true } },
      }),
    );

    expect(result.engagement).toEqual(current.engagement);
    expect(result.groupOverrides["-100"]?.engagement).toEqual({ style: "assistant" });
  });

  it("preserves newly configured routing fields when an older client saves its known fields", () => {
    const current = storedConfig({
      engagement: {
        ...DEFAULT_ENGAGEMENT_POLICY,
        encryptedApiKey: "stored-key",
        addressedConfidenceThreshold: 0.7,
        continueConfidenceThreshold: 0.6,
        continuationWindowSeconds: 0,
      },
      groupOverrides: {
        "-100": {
          chatId: -100,
          whitelisted: true,
          engagement: { addressedConfidenceThreshold: 0.55, continuationWindowSeconds: 60 },
        },
      },
    });
    const {
      addressedConfidenceThreshold: _addressed,
      continueConfidenceThreshold: _continue,
      continuationWindowSeconds: _window,
      ...legacyPolicy
    } = DEFAULT_ENGAGEMENT_POLICY;
    const result = absorb(
      current,
      buildPatch({
        enabled: false,
        engagement: { ...legacyPolicy, preferences: "join specific questions" },
        groupOverrides: {
          "-100": { chatId: -100, whitelisted: true, engagement: { style: "assistant" } },
        },
      }),
    );
    expect(result.engagement).toMatchObject({
      addressedConfidenceThreshold: 0.7,
      continueConfidenceThreshold: 0.6,
      continuationWindowSeconds: 0,
      preferences: "join specific questions",
      encryptedApiKey: "stored-key",
    });
    expect(result.groupOverrides["-100"]?.engagement).toEqual({
      addressedConfidenceThreshold: 0.55,
      continuationWindowSeconds: 60,
      style: "assistant",
    });
    const fresh = absorb(null, buildPatch({ enabled: false, engagement: legacyPolicy }));
    expect(fresh.engagement).toMatchObject({
      addressedConfidenceThreshold: 0.8,
      continueConfidenceThreshold: 0.8,
      continuationWindowSeconds: 120,
    });
  });

  it("encrypts a new engagement key and supports an explicit group inheritance reset", () => {
    const current = storedConfig({
      groupOverrides: {
        "-100": {
          chatId: -100,
          whitelisted: true,
          engagement: { style: "assistant" },
        },
      },
    });
    const result = absorb(
      current,
      buildPatch({
        providers: [{ ...patchProvider, apiKey: "" }],
        engagement: {
          mode: "active",
          style: "natural",
          preferences: "",
          keywordDirect: false,
          cooldownSeconds: 60,
          confidenceThreshold: 0.8,
          contextMessages: 20,
          timeoutMs: 1_000,
          apiKey: "jev-secret",
        },
        groupOverrides: {
          "-100": { chatId: -100, whitelisted: true, engagement: null },
        },
      }),
    );

    expect(decrypt(result.engagement!.encryptedApiKey!, ENCRYPTION_KEY)).toBe("jev-secret");
    expect(result.groupOverrides["-100"]?.engagement).toBeUndefined();
  });
});

describe("durable Issue confirmation policy persistence", () => {
  it("defaults omitted/null to no expiry and round-trips a finite TTL", () => {
    const github = {
      enabled: true,
      publicReadEnabled: true,
      codingAgentEnabled: false,
      authorName: "Bot",
      authorEmail: "bot@example.test",
      repositories: ["owner/repo"],
    };
    const initial = absorb(null, buildPatch({ enabled: false, githubToolsConfig: github }));
    expect(initial.githubToolsConfig?.createIssueConfirmationTtlMinutes).toBeNull();
    const finite = absorb(
      initial,
      buildPatch({
        enabled: false,
        githubToolsConfig: { ...github, createIssueConfirmationTtlMinutes: 60 },
      }),
    );
    expect(toAiConfigPublic(finite).githubToolsConfig?.createIssueConfirmationTtlMinutes).toBe(60);
    const oldClient = absorb(finite, buildPatch({ enabled: false, githubToolsConfig: github }));
    expect(oldClient.githubToolsConfig?.createIssueConfirmationTtlMinutes).toBe(60);
    const never = absorb(
      finite,
      buildPatch({
        enabled: false,
        githubToolsConfig: { ...github, createIssueConfirmationTtlMinutes: null },
      }),
    );
    expect(toAiConfigPublic(never).githubToolsConfig?.createIssueConfirmationTtlMinutes).toBeNull();
  });
});

it("enforces the hidden Issue confirmation policy control on the server", () => {
  const github = {
    enabled: true,
    publicReadEnabled: true,
    codingAgentEnabled: false,
    authorName: "Bot",
    authorEmail: "bot@example.test",
    repositories: ["owner/repo"],
    createIssueConfirmationTtlMinutes: 60,
  };
  const current = absorb(null, buildPatch({ enabled: false, githubToolsConfig: github }));
  expect(() =>
    absorbAiConfigPatch({
      current,
      patch: buildPatch({
        enabled: false,
        githubToolsConfig: { ...github, createIssueConfirmationTtlMinutes: null },
      }),
      actorRole: "editor",
      encryptionKey: ENCRYPTION_KEY,
    }),
  ).toThrow("只有 owner 或 admin");
  expect(
    absorbAiConfigPatch({
      current,
      patch: buildPatch({ enabled: false, githubToolsConfig: github }),
      actorRole: "editor",
      encryptionKey: ENCRYPTION_KEY,
    }).githubToolsConfig?.createIssueConfirmationTtlMinutes,
  ).toBe(60);
});

it("does not let an editor reset a finite Issue policy by omitting the field", () => {
  const github = {
    enabled: true,
    publicReadEnabled: true,
    codingAgentEnabled: false,
    authorName: "Bot",
    authorEmail: "bot@example.test",
    repositories: ["owner/repo"],
  };
  const current = absorb(
    null,
    buildPatch({
      enabled: false,
      githubToolsConfig: { ...github, createIssueConfirmationTtlMinutes: 60 },
    }),
  );
  expect(
    absorbAiConfigPatch({
      current,
      patch: buildPatch({ enabled: false, githubToolsConfig: github }),
      actorRole: "editor",
      encryptionKey: ENCRYPTION_KEY,
    }).githubToolsConfig?.createIssueConfirmationTtlMinutes,
  ).toBe(60);
});

describe("task Agent configuration", () => {
  it("persists explicit no-tools defaults and preserves them for older clients", () => {
    const config = {
      modelId: "task-model",
      toolNames: [],
      timeoutMs: 60_000,
      maxSteps: 12,
      systemPrompt: "Run approved plans",
    };
    const stored = absorb(null, buildPatch({ enabled: false, taskAgentConfig: config }));
    expect(stored.taskAgentConfig).toEqual(config);
    expect(toAiConfigPublic(stored).taskAgentConfig).toEqual(config);
    expect(absorb(stored, buildPatch({ enabled: false })).taskAgentConfig).toEqual(config);
  });
  it("rejects changes from non-administrators", () => {
    expect(() =>
      absorbAiConfigPatch({
        current: null,
        patch: buildPatch({ enabled: false, taskAgentConfig: { toolNames: ["generate_image"] } }),
        actorRole: "member",
        encryptionKey: ENCRYPTION_KEY,
      }),
    ).toThrow("只有 owner 或 admin");
  });
  it("remaps temporary provider IDs without storing credentials in the task config", () => {
    const stored = absorb(
      null,
      buildPatch({
        enabled: false,
        providers: [
          {
            id: "__new_task",
            label: "Tasks",
            baseURL: "https://example.com/v1",
            providerFormat: "openai",
            defaultModel: "task-model",
            apiKey: "private-key",
          },
        ],
        taskAgentConfig: { providerId: "__new_task", modelId: "task-model" },
      }),
    );
    expect(stored.taskAgentConfig?.providerId).toEqual(stored.providers![0]!.id);
    expect(JSON.stringify(toAiConfigPublic(stored).taskAgentConfig)).not.toContain("private-key");
  });
  it("rejects an unknown configured provider", () => {
    expect(() =>
      absorb(null, buildPatch({ enabled: false, taskAgentConfig: { providerId: "missing" } })),
    ).toThrow("Task Agent provider does not exist");
  });
  it.each([{ timeoutMs: 0 }, { timeoutMs: 2_147_483_648 }, { maxSteps: 0 }, { toolNames: [""] }])(
    "validates executable limits: %j",
    (taskAgentConfig) => {
      expect(() => buildPatch({ enabled: false, taskAgentConfig })).toThrow();
    },
  );
});

describe("named task Agents", () => {
  it("persists full execution configuration and rejects non-admin changes", () => {
    const agentToolsConfig = {
      enabled: true,
      agents: {
        researcher: {
          enabled: true,
          modelId: "research",
          toolNames: [],
          timeoutMs: 2000,
          maxSteps: 3,
        },
      },
    };
    const stored = absorb(null, buildPatch({ enabled: false, agentToolsConfig }));
    expect(stored.agentToolsConfig).toEqual(agentToolsConfig);
    expect(absorb(stored, buildPatch({ enabled: false })).agentToolsConfig).toEqual(
      agentToolsConfig,
    );
    expect(() =>
      absorbAiConfigPatch({
        current: null,
        patch: buildPatch({ enabled: false, agentToolsConfig }),
        actorRole: "member",
        encryptionKey: ENCRYPTION_KEY,
      }),
    ).toThrow("只有 owner 或 admin");
  });
});
