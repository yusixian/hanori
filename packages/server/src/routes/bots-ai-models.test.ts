import type { Database } from "@cos-tool-bot/database";
import type { AiConfigStored } from "@cos-tool-bot/shared";
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AuthVariables } from "../middleware/better-auth.js";
import type { BotPool } from "../services/bot-pool.js";
import type { ModelCapabilityService } from "../services/model-capability-service.js";
import { encrypt } from "../utils/crypto.js";
import { env } from "../env.js";
import { botsRoutes } from "./bots.js";

vi.hoisted(() => {
  process.env.DATABASE_URL ||= "postgresql://localhost/cos_tool_bot_test";
  process.env.BETTER_AUTH_SECRET ||= "test-secret";
  process.env.AUTH_OWNER_EMAIL ||= "owner@example.com";
  process.env.ENCRYPTION_KEY ||= "test-encryption-key";
});

function storedAiConfig(): AiConfigStored {
  return {
    enabled: true,
    encryptedApiKey: null,
    baseURL: "https://legacy.example/v1",
    model: "legacy-model",
    providers: [
      {
        id: "active-provider",
        label: "Active",
        encryptedApiKey: encrypt("active-secret", env.ENCRYPTION_KEY),
        baseURL: "https://active.example/v1",
        providerFormat: "openai",
        defaultModel: "active-model",
      },
      {
        id: "target-provider",
        label: "Target",
        encryptedApiKey: encrypt("target-secret", env.ENCRYPTION_KEY),
        baseURL: "https://target.example/v1",
        modelDiscoveryPath: "/catalog/models",
        providerFormat: "openai",
        defaultModel: "target-model",
      },
    ],
    activeProviderId: "active-provider",
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
}

function routeDatabase(aiConfig: AiConfigStored | null = storedAiConfig()): Database {
  return {
    select: () => ({
      from: () => ({ where: async () => [{ aiConfig }] }),
    }),
  } as unknown as Database;
}

function routeApp(aiConfig: AiConfigStored | null = storedAiConfig()) {
  const modelCapabilityService = {
    inferCapabilities: (modelId: string) => (modelId.includes("vision") ? ["vision"] : []),
  } as unknown as ModelCapabilityService;
  return new Hono<{ Variables: AuthVariables }>().route(
    "/api/bots",
    botsRoutes(routeDatabase(aiConfig), {} as BotPool, modelCapabilityService),
  );
}

const fetchMock = vi.fn();

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("provider-scoped AI model discovery", () => {
  it("uses the explicitly targeted provider instead of the active provider", async () => {
    fetchMock.mockResolvedValue(
      new Response(
        JSON.stringify({
          data: [{ id: "target-model" }, { id: "vision-model", owned_by: "vendor" }],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );

    const response = await routeApp().request("/api/bots/bot-1/ai-models", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ providerId: "target-provider" }),
    });

    expect(response.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledWith(
      "https://target.example/v1/catalog/models",
      expect.objectContaining({
        headers: { Authorization: "Bearer target-secret" },
        redirect: "error",
        signal: expect.any(AbortSignal),
      }),
    );
    expect(await response.json()).toEqual({
      ok: true,
      data: [
        { id: "target-model", capabilities: [] },
        { id: "vision-model", owned_by: "vendor", capabilities: ["vision"] },
      ],
    });
  });

  it("uses the active provider for legacy requests without a provider ID", async () => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ data: [{ id: "active-model" }] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );

    const response = await routeApp().request("/api/bots/bot-1/ai-models", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });

    expect(response.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledWith(
      "https://active.example/v1/models",
      expect.objectContaining({
        headers: { Authorization: "Bearer active-secret" },
      }),
    );
  });

  it("uses the legacy /models path when a saved provider has no discovery setting", async () => {
    const config = storedAiConfig();
    config.providers![1]!.modelDiscoveryPath = undefined;
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ data: [] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );

    const response = await routeApp(config).request("/api/bots/bot-1/ai-models", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ providerId: "target-provider" }),
    });

    expect(response.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledWith("https://target.example/v1/models", expect.any(Object));
  });

  it("requires a new API key before testing a changed base URL", async () => {
    const response = await routeApp().request("/api/bots/bot-1/ai-models", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        providerId: "target-provider",
        baseURL: "https://other.example/v1",
      }),
    });

    expect(response.status).toBe(400);
    expect(await response.text()).toContain("API key is required");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("uses complete draft credentials for a new provider", async () => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ data: [{ id: "draft-model" }] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );

    const response = await routeApp().request("/api/bots/bot-1/ai-models", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        providerId: "__new_provider",
        baseURL: "https://draft.example/v1",
        apiKey: "draft-secret",
        modelDiscoveryPath: "/custom/models",
      }),
    });

    expect(response.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledWith(
      "https://draft.example/v1/custom/models",
      expect.objectContaining({
        headers: { Authorization: "Bearer draft-secret" },
      }),
    );
  });

  it("trims draft API keys before sending the discovery request", async () => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ data: [] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );

    const response = await routeApp().request("/api/bots/bot-1/ai-models", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        providerId: "__new_provider",
        baseURL: "https://draft.example/v1",
        apiKey: "  draft-secret  ",
        modelDiscoveryPath: "/models",
      }),
    });

    expect(response.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledWith(
      "https://draft.example/v1/models",
      expect.objectContaining({
        headers: { Authorization: "Bearer draft-secret" },
      }),
    );
  });

  it("rejects an incomplete draft for an unknown provider", async () => {
    const response = await routeApp().request("/api/bots/bot-1/ai-models", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        providerId: "__new_provider",
        baseURL: "https://draft.example/v1",
        apiKey: "draft-secret",
      }),
    });

    expect(response.status).toBe(400);
    expect(await response.text()).toContain("complete draft");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each(["", "https://evil.example/models", "//evil.example/models", "/\\evil"])(
    "rejects the unsafe or disabled discovery path %j",
    async (modelDiscoveryPath) => {
      const response = await routeApp().request("/api/bots/bot-1/ai-models", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          providerId: "target-provider",
          modelDiscoveryPath,
        }),
      });

      expect(response.status).toBe(400);
      expect(fetchMock).not.toHaveBeenCalled();
    },
  );

  it.each([
    { data: "not-an-array" },
    { data: [{}] },
    { data: [{ id: "" }] },
    { models: [{ id: "wrong-shape" }] },
  ])("rejects an invalid upstream model payload", async (payload) => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify(payload), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );

    const response = await routeApp().request("/api/bots/bot-1/ai-models", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ providerId: "target-provider" }),
    });

    expect(response.status).toBe(502);
    expect(await response.text()).toContain("invalid response");
  });

  it("de-duplicates model IDs returned by the upstream provider", async () => {
    fetchMock.mockResolvedValue(
      new Response(
        JSON.stringify({
          data: [
            { id: "duplicate-model", owned_by: "first" },
            { id: "duplicate-model", owned_by: "second" },
            { id: "unique-model" },
          ],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );

    const response = await routeApp().request("/api/bots/bot-1/ai-models", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ providerId: "target-provider" }),
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      ok: true,
      data: [
        { id: "duplicate-model", owned_by: "first", capabilities: [] },
        { id: "unique-model", capabilities: [] },
      ],
    });
  });

  it("rejects an oversized successful discovery response", async () => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ data: [] }), {
        status: 200,
        headers: {
          "Content-Type": "application/json",
          "Content-Length": String(2 * 1024 * 1024 + 1),
        },
      }),
    );

    const response = await routeApp().request("/api/bots/bot-1/ai-models", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ providerId: "target-provider" }),
    });

    expect(response.status).toBe(502);
    expect(await response.text()).toContain("exceeds the 2097152-byte limit");
  });

  it("redacts and truncates an upstream error body", async () => {
    fetchMock.mockResolvedValue(
      new Response(`target-secret ${"x".repeat(800)}`, {
        status: 401,
      }),
    );

    const response = await routeApp().request("/api/bots/bot-1/ai-models", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ providerId: "target-provider" }),
    });
    const body = await response.text();

    expect(response.status).toBe(502);
    expect(body).not.toContain("target-secret");
    expect(body).toContain("[REDACTED]");
    expect(body.length).toBeLessThan(650);
  });

  it("returns a timeout response without waiting for the real timeout", async () => {
    const timeoutError = new Error("timed out");
    timeoutError.name = "TimeoutError";
    fetchMock.mockRejectedValue(timeoutError);

    const response = await routeApp().request("/api/bots/bot-1/ai-models", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ providerId: "target-provider" }),
    });

    expect(response.status).toBe(504);
    expect(await response.text()).toContain("15 seconds");
  });

  it("does not expose the API key from a transport error", async () => {
    fetchMock.mockRejectedValue(new Error("transport failed for target-secret"));

    const response = await routeApp().request("/api/bots/bot-1/ai-models", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ providerId: "target-provider" }),
    });
    const body = await response.text();

    expect(response.status).toBe(502);
    expect(body).not.toContain("target-secret");
    expect(body).toContain("[REDACTED]");
  });
});
