import type { Database } from "@cos-tool-bot/database";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { describe, expect, it, vi } from "vitest";
import type { AuthVariables } from "../middleware/better-auth.js";
import type { BotPool } from "../services/bot-pool.js";
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

function routeDatabase(onSave?: (aiConfig: unknown) => void): Database {
  return {
    select: () => ({
      from: () => ({ where: async () => [{ aiConfig: existingAiConfig }] }),
    }),
    update: () => ({
      set: (value: { aiConfig: unknown }) => {
        onSave?.(value.aiConfig);
        return { where: async () => undefined };
      },
    }),
  } as unknown as Database;
}

function routeApp(db: Database, botPool: BotPool) {
  return new Hono<{ Variables: AuthVariables }>()
    .onError((error, c) => {
      if (error instanceof HTTPException) {
        return c.json({ ok: false as const, error: error.message }, error.status);
      }
      return c.json({ ok: false as const, error: "Internal Server Error" }, 500);
    })
    .use("*", ownerContext())
    .route("/api/bots", botsRoutes(db, botPool, {} as ModelCapabilityService));
}

describe("AI config GitHub coding provider contract", () => {
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
