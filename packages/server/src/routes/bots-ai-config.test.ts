import type { Database } from "@cos-tool-bot/database";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { describe, expect, it, vi } from "vitest";
import type { AuthVariables } from "../middleware/better-auth.js";
import type { BotPool } from "../services/bot-pool.js";
import type { ChatAiSelectionService } from "../services/chat-ai-selection-service.js";
import type { ModelCapabilityService } from "../services/model-capability-service.js";
import { botsRoutes } from "./bots.js";

vi.hoisted(() => {
  process.env.DATABASE_URL ||= "postgresql://localhost/cos_tool_bot_test";
  process.env.BETTER_AUTH_SECRET ||= "test-secret";
  process.env.AUTH_OWNER_EMAIL ||= "owner@example.com";
});

const existingAiConfig = {
  enabled: false,
  encryptedApiKey: null,
  baseURL: "",
  model: "",
  systemPrompt: "Be helpful.",
  triggerConfig: {
    replyToBot: true,
    mentionBot: true,
    triggerWords: [],
    randomReplyPercent: 0,
    randomReplyCooldown: 60,
  },
  groupOverrides: {},
};

function requestBody() {
  return {
    revision: "0",
    enabled: false,
    baseURL: "",
    model: "",
    systemPrompt: "Be helpful.",
    triggerConfig: existingAiConfig.triggerConfig,
    groupOverrides: {},
  };
}

function ownerContext() {
  return async (
    c: { set: (key: keyof AuthVariables, value: never) => void },
    next: () => Promise<void>,
  ) => {
    c.set("authMember", {
      id: "member-1",
      userId: "user-1",
      organizationId: "org-1",
      role: "owner",
    } as never);
    await next();
  };
}

function routeDatabase(
  onSave?: (aiConfig: unknown) => void,
  aiConfig: unknown = existingAiConfig,
  updatedAt: Date | null = null,
): Database {
  return {
    select: () => ({
      from: () => ({ where: async () => [{ aiConfig, updatedAt }] }),
    }),
    update: () => ({
      set: (value: { aiConfig: unknown }) => {
        onSave?.(value.aiConfig);
        return { where: async () => undefined };
      },
    }),
  } as unknown as Database;
}

function routeApp(db: Database, botPool: BotPool, chatAiSelectionService?: ChatAiSelectionService) {
  return new Hono<{ Variables: AuthVariables }>()
    .onError((error, c) => {
      if (error instanceof HTTPException) {
        return c.json({ ok: false as const, error: error.message }, error.status);
      }
      return c.json({ ok: false as const, error: "Internal Server Error" }, 500);
    })
    .use("*", ownerContext())
    .route(
      "/api/bots",
      botsRoutes(db, botPool, {} as ModelCapabilityService, undefined, chatAiSelectionService),
    );
}

function savingBotPool(): BotPool {
  return {
    withAiConfigLock: async (_botId: string, operation: () => Promise<unknown>) => operation(),
    invalidateGitHubCredentials: vi.fn(),
    getManager: () => undefined,
  } as unknown as BotPool;
}

describe("AI config GitHub coding provider contract", () => {
  it("rejects a stale full-page save before it can overwrite a newer group patch", async () => {
    const save = vi.fn();
    const updatedAt = new Date("2026-07-27T12:00:00.000Z");
    const app = routeApp(routeDatabase(save, existingAiConfig, updatedAt), savingBotPool());
    const loaded = await app.request("/api/bots/bot-1/ai-config");
    expect(await loaded.json()).toMatchObject({
      ok: true,
      revision: updatedAt.toISOString(),
    });

    const response = await app.request("/api/bots/bot-1/ai-config", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(requestBody()),
    });

    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      ok: false,
      code: "stale_revision",
      latest: { revision: updatedAt.toISOString() },
    });
    expect(save).not.toHaveBeenCalled();
  });

  it("fills the group history budget for legacy conversation config saves", async () => {
    let savedAiConfig: Record<string, unknown> | undefined;
    const response = await routeApp(
      routeDatabase((aiConfig) => {
        savedAiConfig = aiConfig as Record<string, unknown>;
      }),
      savingBotPool(),
    ).request("/api/bots/bot-1/ai-config", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        ...requestBody(),
        conversationConfig: {
          enabled: true,
          maxContextMessages: 20,
          historyFormat: "prompt",
          groupBufferSize: 50,
          groupContextMode: "all",
          saveGroupContext: "random_only",
          autoSummarize: true,
          summarizeThreshold: 30,
          retentionDays: 30,
          maxRawMessagesPerChat: 50_000,
        },
      }),
    });

    expect(response.status).toBe(200);
    expect(savedAiConfig?.["conversationConfig"]).toMatchObject({
      groupHistoryMaxTokens: 12_000,
    });
  });

  it("returns a non-2xx response and logs when the saved config cannot restart the bot", async () => {
    let saved = false;
    const restartError = new Error("restart-secret-detail");
    const invalidateGitHubCredentials = vi.fn();
    const restartBot = vi.fn(async () => {
      expect(saved).toBe(true);
      throw restartError;
    });
    const botPool = {
      withAiConfigLock: async (_botId: string, operation: () => Promise<unknown>) => operation(),
      invalidateGitHubCredentials,
      getManager: () => ({}),
      restartBot,
    } as unknown as BotPool;
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);

    try {
      const response = await routeApp(
        routeDatabase(() => {
          saved = true;
        }),
        botPool,
      ).request("/api/bots/bot-1/ai-config", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(requestBody()),
      });
      const responseBody = await response.text();

      expect(response.status).toBe(503);
      expect(responseBody).toContain("AI 配置已保存，但 Bot 重启失败");
      expect(responseBody).not.toContain("restart-secret-detail");
      expect(invalidateGitHubCredentials).toHaveBeenCalledWith("bot-1");
      expect(restartBot).toHaveBeenCalledWith("bot-1");
      expect(errorSpy).toHaveBeenCalledWith("Bot restart after AI config save failed", {
        botId: "bot-1",
        error: restartError,
      });
    } finally {
      errorSpy.mockRestore();
    }
  });

  it("rejects a dedicated coding provider without an API key", async () => {
    const save = vi.fn();
    const botPool = {
      withAiConfigLock: async (_botId: string, operation: () => Promise<unknown>) => operation(),
    } as unknown as BotPool;
    const response = await routeApp(routeDatabase(save), botPool).request(
      "/api/bots/bot-1/ai-config",
      {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...requestBody(),
          providers: [
            {
              id: "no-key",
              label: "No key",
              baseURL: "https://provider.example/v1",
              providerFormat: "openai",
              defaultModel: "coding-model",
            },
          ],
          githubToolsConfig: {
            enabled: true,
            publicReadEnabled: true,
            codingAgentEnabled: true,
            codingProviderId: "no-key",
            authorName: "Ai-chan",
            authorEmail: "ai@example.com",
            repositories: [],
          },
        }),
      },
    );

    expect(response.status).toBe(400);
    expect(await response.text()).toContain("API Key");
    expect(save).not.toHaveBeenCalled();
  });

  it("accepts a new dedicated provider whose API key is supplied in the same save", async () => {
    let savedAiConfig: Record<string, unknown> | undefined;
    const botPool = {
      withAiConfigLock: async (_botId: string, operation: () => Promise<unknown>) => operation(),
      invalidateGitHubCredentials: vi.fn(),
      getManager: () => undefined,
    } as unknown as BotPool;
    const response = await routeApp(
      routeDatabase((aiConfig) => {
        savedAiConfig = aiConfig as Record<string, unknown>;
      }),
      botPool,
    ).request("/api/bots/bot-1/ai-config", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        ...requestBody(),
        providers: [
          {
            id: "__new_coding",
            label: "New coding provider",
            apiKey: "same-save-secret",
            baseURL: "https://provider.example/v1",
            providerFormat: "openai",
            defaultModel: "coding-model",
          },
        ],
        githubToolsConfig: {
          enabled: true,
          publicReadEnabled: true,
          codingAgentEnabled: true,
          codingProviderId: "__new_coding",
          authorName: "Ai-chan",
          authorEmail: "ai@example.com",
          repositories: [],
        },
      }),
    });

    expect(response.status).toBe(200);
    const providers = savedAiConfig?.providers as Array<{
      id: string;
      encryptedApiKey: string | null;
    }>;
    const github = savedAiConfig?.githubToolsConfig as { codingProviderId?: string };
    expect(providers).toHaveLength(1);
    expect(providers[0]?.id).not.toBe("__new_coding");
    expect(providers[0]?.encryptedApiKey).toBeTruthy();
    expect(github.codingProviderId).toBe(providers[0]?.id);
  });
});

describe("AI provider model configuration", () => {
  it("preserves the durable active pair and reconciles chat selections after catalog edits", async () => {
    let savedAiConfig: Record<string, unknown> | undefined;
    const reconcileCatalog = vi.fn(async () => ({
      persisted: true,
      applied: true,
      applyState: "applied" as const,
      reset: 0,
      defaulted: 0,
    }));
    const existing = {
      ...existingAiConfig,
      providers: [
        {
          id: "provider-a",
          label: "Provider A",
          encryptedApiKey: "encrypted-a",
          baseURL: "https://a.example/v1",
          providerFormat: "openai" as const,
          defaultModel: "model-a",
          models: [{ id: "model-a" }],
        },
        {
          id: "provider-b",
          label: "Provider B",
          encryptedApiKey: "encrypted-b",
          baseURL: "https://b.example/v1",
          providerFormat: "openai" as const,
          defaultModel: "model-b-default",
          models: [{ id: "model-b-default" }, { id: "model-b-active" }],
        },
      ],
      activeProviderId: "provider-b",
      activeModelId: "model-b-active",
      aiSelectionDisplayDefault: "hide" as const,
    };
    const service = { reconcileCatalog } as unknown as ChatAiSelectionService;
    const response = await routeApp(
      routeDatabase((aiConfig) => {
        savedAiConfig = aiConfig as Record<string, unknown>;
      }, existing),
      savingBotPool(),
      service,
    ).request("/api/bots/bot-1/ai-config", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        ...requestBody(),
        providers: [
          {
            id: "provider-a",
            label: "Provider A renamed",
            baseURL: "https://a.example/v1",
            providerFormat: "openai",
            defaultModel: "model-a",
            models: [{ id: "model-a" }],
          },
          {
            id: "provider-b",
            label: "Provider B renamed",
            baseURL: "https://b.example/v1",
            providerFormat: "openai",
            defaultModel: "model-b-default",
            models: [{ id: "model-b-default" }, { id: "model-b-active" }],
          },
        ],
        activeProviderId: "provider-a",
        activeModelId: "model-a",
        aiSelectionDisplayDefault: "show",
      }),
    });

    expect(response.status).toBe(200);
    expect(savedAiConfig).toMatchObject({
      activeProviderId: "provider-b",
      activeModelId: "model-b-active",
      aiSelectionDisplayDefault: "hide",
    });
    expect(reconcileCatalog).toHaveBeenCalledWith("bot-1");
  });

  it("returns the provider discovery path and preserves model thinking settings", async () => {
    const response = await routeApp(
      routeDatabase(undefined, {
        ...existingAiConfig,
        providers: [
          {
            id: "provider-1",
            label: "Provider",
            encryptedApiKey: null,
            baseURL: "https://provider.example/v1",
            modelDiscoveryPath: "/catalog/models",
            providerFormat: "openai",
            defaultModel: "reasoning-model",
            models: [
              {
                id: "reasoning-model",
                thinking: "enabled",
                thinkingBudget: 256,
              },
            ],
          },
        ],
        activeProviderId: "provider-1",
      }),
      {} as BotPool,
    ).request("/api/bots/bot-1/ai-config");

    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      data: {
        providers: Array<{
          modelDiscoveryPath?: string;
          models?: Array<{ thinking?: string; thinkingBudget?: number }>;
        }>;
      };
    };
    expect(body.data.providers[0]).toMatchObject({
      modelDiscoveryPath: "/catalog/models",
      models: [{ thinking: "enabled", thinkingBudget: 256 }],
    });
  });

  it("round-trips discovery and thinking settings through the provider save schema", async () => {
    let savedAiConfig: Record<string, unknown> | undefined;
    const botPool = {
      withAiConfigLock: async (_botId: string, operation: () => Promise<unknown>) => operation(),
      invalidateGitHubCredentials: vi.fn(),
      getManager: () => undefined,
    } as unknown as BotPool;
    const response = await routeApp(
      routeDatabase((aiConfig) => {
        savedAiConfig = aiConfig as Record<string, unknown>;
      }),
      botPool,
    ).request("/api/bots/bot-1/ai-config", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        ...requestBody(),
        providers: [
          {
            id: "__new_provider",
            label: "Provider",
            baseURL: "https://provider.example/v1",
            modelDiscoveryPath: "/catalog/models",
            providerFormat: "openai",
            defaultModel: "reasoning-model",
            models: [
              {
                id: "reasoning-model",
                thinking: "enabled",
                thinkingBudget: 512,
              },
            ],
          },
        ],
        activeProviderId: "__new_provider",
      }),
    });

    expect(response.status).toBe(200);
    expect(savedAiConfig?.providers).toEqual([
      expect.objectContaining({
        modelDiscoveryPath: "/catalog/models",
        models: [
          {
            id: "reasoning-model",
            thinking: "enabled",
            thinkingBudget: 512,
          },
        ],
      }),
    ]);
  });

  it("rejects enabling AI when any saved provider has no resolvable default model", async () => {
    const save = vi.fn();
    const botPool = {
      withAiConfigLock: async (_botId: string, operation: () => Promise<unknown>) => operation(),
    } as unknown as BotPool;
    const response = await routeApp(routeDatabase(save), botPool).request(
      "/api/bots/bot-1/ai-config",
      {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...requestBody(),
          enabled: true,
          providers: [
            {
              id: "__new_ready",
              label: "Ready",
              baseURL: "https://ready.example/v1",
              providerFormat: "openai",
              defaultModel: "ready-model",
            },
            {
              id: "__new_draft",
              label: "Draft",
              baseURL: "https://draft.example/v1",
              providerFormat: "openai",
              defaultModel: "",
              models: [],
            },
          ],
        }),
      },
    );

    expect(response.status).toBe(400);
    expect(save).not.toHaveBeenCalled();
  });

  it("resolves the first catalog entry as the provider default model when saving", async () => {
    let savedAiConfig: Record<string, unknown> | undefined;
    const botPool = {
      withAiConfigLock: async (_botId: string, operation: () => Promise<unknown>) => operation(),
      invalidateGitHubCredentials: vi.fn(),
      getManager: () => undefined,
    } as unknown as BotPool;
    const response = await routeApp(
      routeDatabase((aiConfig) => {
        savedAiConfig = aiConfig as Record<string, unknown>;
      }),
      botPool,
    ).request("/api/bots/bot-1/ai-config", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        ...requestBody(),
        enabled: true,
        providers: [
          {
            id: "__new_provider",
            label: "Provider",
            baseURL: "https://provider.example/v1",
            providerFormat: "openai",
            defaultModel: "",
            models: [{ id: "catalog-default" }],
          },
        ],
      }),
    });

    expect(response.status).toBe(200);
    expect(savedAiConfig?.providers).toEqual([
      expect.objectContaining({ defaultModel: "catalog-default" }),
    ]);
  });

  it.each(["https://evil.example/models", "//evil.example/models", "/\\evil"])(
    "rejects an unsafe provider discovery path %j before saving",
    async (modelDiscoveryPath) => {
      const save = vi.fn();
      const response = await routeApp(routeDatabase(save), {} as BotPool).request(
        "/api/bots/bot-1/ai-config",
        {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            ...requestBody(),
            providers: [
              {
                id: "__new_provider",
                label: "Provider",
                baseURL: "https://provider.example/v1",
                modelDiscoveryPath,
                providerFormat: "openai",
                defaultModel: "model",
              },
            ],
          }),
        },
      );

      expect(response.status).toBe(400);
      expect(save).not.toHaveBeenCalled();
    },
  );

  it("allows an empty discovery path to disable fetching", async () => {
    let savedAiConfig: Record<string, unknown> | undefined;
    const botPool = {
      withAiConfigLock: async (_botId: string, operation: () => Promise<unknown>) => operation(),
      invalidateGitHubCredentials: vi.fn(),
      getManager: () => undefined,
    } as unknown as BotPool;
    const response = await routeApp(
      routeDatabase((aiConfig) => {
        savedAiConfig = aiConfig as Record<string, unknown>;
      }),
      botPool,
    ).request("/api/bots/bot-1/ai-config", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        ...requestBody(),
        providers: [
          {
            id: "__new_provider",
            label: "Provider",
            baseURL: "https://provider.example/v1",
            modelDiscoveryPath: "",
            providerFormat: "gemini",
            defaultModel: "gemini-model",
          },
        ],
      }),
    });

    expect(response.status).toBe(200);
    expect(savedAiConfig?.providers).toEqual([expect.objectContaining({ modelDiscoveryPath: "" })]);
  });

  it("requires a new API key before saving a changed base URL", async () => {
    const save = vi.fn();
    const response = await routeApp(
      routeDatabase(save, {
        ...existingAiConfig,
        providers: [
          {
            id: "provider-1",
            label: "Provider",
            encryptedApiKey: "encrypted-existing-key",
            baseURL: "https://old.example/v1",
            providerFormat: "openai",
            defaultModel: "model",
          },
        ],
        activeProviderId: "provider-1",
      }),
      savingBotPool(),
    ).request("/api/bots/bot-1/ai-config", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        ...requestBody(),
        providers: [
          {
            id: "provider-1",
            label: "Provider",
            baseURL: "https://new.example/v1",
            providerFormat: "openai",
            defaultModel: "model",
          },
        ],
        activeProviderId: "provider-1",
      }),
    });

    expect(response.status).toBe(400);
    expect(await response.text()).toContain("requires a new API key");
    expect(save).not.toHaveBeenCalled();
  });

  it("allows a keyless draft provider to change its base URL", async () => {
    let savedAiConfig: Record<string, unknown> | undefined;
    const response = await routeApp(
      routeDatabase(
        (aiConfig) => {
          savedAiConfig = aiConfig as Record<string, unknown>;
        },
        {
          ...existingAiConfig,
          providers: [
            {
              id: "provider-1",
              label: "Draft",
              encryptedApiKey: null,
              baseURL: "https://old.example/v1",
              providerFormat: "openai",
              defaultModel: "",
              models: [],
            },
          ],
          activeProviderId: "provider-1",
        },
      ),
      savingBotPool(),
    ).request("/api/bots/bot-1/ai-config", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        ...requestBody(),
        providers: [
          {
            id: "provider-1",
            label: "Draft",
            baseURL: "https://new.example/v1",
            providerFormat: "openai",
            defaultModel: "",
            models: [],
          },
        ],
        activeProviderId: "provider-1",
      }),
    });

    expect(response.status).toBe(200);
    expect(savedAiConfig?.providers).toEqual([
      expect.objectContaining({
        id: "provider-1",
        baseURL: "https://new.example/v1",
        encryptedApiKey: null,
      }),
    ]);
  });

  it("rejects duplicate provider IDs before saving", async () => {
    const save = vi.fn();
    const response = await routeApp(routeDatabase(save), savingBotPool()).request(
      "/api/bots/bot-1/ai-config",
      {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...requestBody(),
          providers: [
            {
              id: "duplicate",
              label: "One",
              baseURL: "https://one.example/v1",
              providerFormat: "openai",
              defaultModel: "one",
            },
            {
              id: "duplicate",
              label: "Two",
              baseURL: "https://two.example/v1",
              providerFormat: "openai",
              defaultModel: "two",
            },
          ],
        }),
      },
    );

    expect(response.status).toBe(400);
    expect(save).not.toHaveBeenCalled();
  });

  it("trims and de-duplicates a saved provider catalog", async () => {
    let savedAiConfig: Record<string, unknown> | undefined;
    const response = await routeApp(
      routeDatabase((aiConfig) => {
        savedAiConfig = aiConfig as Record<string, unknown>;
      }),
      savingBotPool(),
    ).request("/api/bots/bot-1/ai-config", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        ...requestBody(),
        providers: [
          {
            id: "__new_provider",
            label: "Provider",
            baseURL: "https://provider.example/v1",
            modelDiscoveryPath: "  /catalog/models  ",
            providerFormat: "openai",
            defaultModel: "  first-model  ",
            models: [
              { id: "  first-model  ", thinking: "enabled", thinkingBudget: 64 },
              { id: "first-model", label: "duplicate" },
              { id: "second-model" },
            ],
          },
        ],
      }),
    });

    expect(response.status).toBe(200);
    expect(savedAiConfig?.providers).toEqual([
      expect.objectContaining({
        defaultModel: "first-model",
        modelDiscoveryPath: "/catalog/models",
        models: [
          { id: "first-model", thinking: "enabled", thinkingBudget: 64 },
          { id: "second-model" },
        ],
      }),
    ]);
  });

  it("remaps image OCR references from a temporary provider ID", async () => {
    let savedAiConfig: Record<string, unknown> | undefined;
    const response = await routeApp(
      routeDatabase((aiConfig) => {
        savedAiConfig = aiConfig as Record<string, unknown>;
      }),
      savingBotPool(),
    ).request("/api/bots/bot-1/ai-config", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        ...requestBody(),
        providers: [
          {
            id: "__new_ocr",
            label: "OCR",
            baseURL: "https://ocr.example/v1",
            providerFormat: "openai",
            defaultModel: "vision-model",
          },
        ],
        activeProviderId: "__new_ocr",
        imageOcrConfig: {
          enabled: true,
          providerId: "__new_ocr",
          modelId: "vision-model",
        },
      }),
    });

    expect(response.status).toBe(200);
    const providers = savedAiConfig?.providers as Array<{ id: string }>;
    expect(savedAiConfig?.imageOcrConfig).toEqual({
      enabled: true,
      providerId: providers[0]?.id,
      modelId: "vision-model",
    });
    expect(providers[0]?.id).not.toBe("__new_ocr");
  });
});
