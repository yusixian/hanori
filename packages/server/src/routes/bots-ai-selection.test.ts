import type { Database } from "@cos-tool-bot/database";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { describe, expect, it, vi } from "vitest";
import type { AuthVariables } from "../middleware/better-auth.js";
import type { BotPool } from "../services/bot-pool.js";
import {
  ChatAiSelectionError,
  type ChatAiSelectionService,
} from "../services/chat-ai-selection-service.js";
import type { ModelCapabilityService } from "../services/model-capability-service.js";
import { botsRoutes } from "./bots.js";

vi.hoisted(() => {
  process.env.DATABASE_URL ||= "postgresql://localhost/cos_tool_bot_test";
  process.env.BETTER_AUTH_SECRET ||= "test-secret";
  process.env.AUTH_OWNER_EMAIL ||= "owner@example.com";
  process.env.ENCRYPTION_KEY ||= "test-encryption-key";
});

const globalSelection = {
  revision: "2026-07-27T12:00:00.000Z",
  applyState: "applied" as const,
  displayDefault: "show" as const,
  selection: {
    providerId: "provider-1",
    modelId: "model-1",
    providerLabel: "Provider One",
    modelLabel: "Model One",
  },
  options: [
    {
      id: "provider-1",
      label: "Provider One",
      defaultModelId: "model-1",
      models: [{ id: "model-1", label: "Model One" }],
    },
  ],
};

function selectionService(overrides: Partial<ChatAiSelectionService> = {}) {
  return {
    readGlobal: vi.fn(async () => globalSelection),
    setGlobal: vi.fn(async () => ({
      persisted: true,
      applied: true,
      applyState: "applied",
      global: globalSelection,
    })),
    retryPublish: vi.fn(async () => ({ persisted: true, applied: true, applyState: "applied" })),
    ...overrides,
  } as unknown as ChatAiSelectionService;
}

function routeApp(role: string, service: ChatAiSelectionService) {
  return new Hono<{ Variables: AuthVariables }>()
    .onError((error, c) => {
      if (error instanceof HTTPException) {
        return c.json({ ok: false as const, error: error.message }, error.status);
      }
      return c.json({ ok: false as const, error: "Internal Server Error" }, 500);
    })
    .use("*", async (c, next) => {
      c.set("authUser", { id: "auth-user-1" } as AuthVariables["authUser"]);
      c.set("authMember", { role } as AuthVariables["authMember"]);
      await next();
    })
    .route(
      "/api/bots",
      botsRoutes({} as Database, {} as BotPool, {} as ModelCapabilityService, undefined, service),
    );
}

describe("Better Auth AI selection routes", () => {
  it("returns the safe catalog to a reader without credential fields", async () => {
    const response = await routeApp("viewer", selectionService()).request(
      "/api/bots/bot-1/ai-selection",
    );

    expect(response.status).toBe(200);
    const text = await response.text();
    expect(text).toContain("Provider One");
    expect(text).toContain('"canManage":false');
    expect(text).not.toContain("apiKey");
    expect(text).not.toContain("baseURL");
  });

  it("allows only owner/admin writes and forwards the Better Auth actor", async () => {
    const deniedService = selectionService();
    const denied = await routeApp("editor", deniedService).request("/api/bots/bot-1/ai-selection", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        expectedRevision: globalSelection.revision,
        providerId: "provider-1",
        modelId: "model-1",
        displayDefault: "show",
      }),
    });
    expect(denied.status).toBe(403);
    expect(deniedService.setGlobal).not.toHaveBeenCalled();
    const deniedRetry = await routeApp("editor", deniedService).request(
      "/api/bots/bot-1/ai-selection/retry",
      { method: "POST" },
    );
    expect(deniedRetry.status).toBe(403);
    expect(deniedService.retryPublish).not.toHaveBeenCalled();

    const allowedService = selectionService();
    const allowed = await routeApp("admin", allowedService).request(
      "/api/bots/bot-1/ai-selection",
      {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          expectedRevision: globalSelection.revision,
          providerId: "provider-1",
          modelId: null,
          displayDefault: "hide",
        }),
      },
    );
    expect(allowed.status).toBe(200);
    expect(allowedService.setGlobal).toHaveBeenCalledWith({
      botId: "bot-1",
      expectedRevision: globalSelection.revision,
      pair: { providerId: "provider-1", modelId: null },
      displayDefault: "hide",
      actor: { kind: "better_auth_user", id: "auth-user-1" },
    });
  });

  it("rejects unknown fields before invoking the service", async () => {
    const service = selectionService();
    const response = await routeApp("owner", service).request("/api/bots/bot-1/ai-selection", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        expectedRevision: globalSelection.revision,
        providerId: "provider-1",
        modelId: "model-1",
        displayDefault: "show",
        apiKey: "must-not-pass",
      }),
    });
    expect(response.status).toBe(400);
    expect(service.setGlobal).not.toHaveBeenCalled();
  });

  it("returns a safe latest snapshot for stale writes", async () => {
    const service = selectionService({
      setGlobal: vi.fn(async () => {
        throw new ChatAiSelectionError("stale_revision", "Stale AI selection revision");
      }),
    });
    const response = await routeApp("owner", service).request("/api/bots/bot-1/ai-selection", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        expectedRevision: "old",
        providerId: "provider-1",
        modelId: "model-1",
        displayDefault: "show",
      }),
    });

    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      ok: false,
      code: "stale_revision",
      latest: { revision: globalSelection.revision },
    });
  });

  it("never exposes internal retry errors", async () => {
    const service = selectionService({
      retryPublish: vi.fn(async () => {
        throw new Error("runtime-secret-detail");
      }),
    });
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      const response = await routeApp("owner", service).request(
        "/api/bots/bot-1/ai-selection/retry",
        { method: "POST" },
      );
      expect(response.status).toBe(500);
      const text = await response.text();
      expect(text).toContain("AI selection request failed");
      expect(text).not.toContain("runtime-secret-detail");
    } finally {
      errorSpy.mockRestore();
    }
  });
});
