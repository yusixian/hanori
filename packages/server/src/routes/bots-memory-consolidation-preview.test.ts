import type { Database } from "@cos-tool-bot/database";
import { Hono } from "hono";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AuthVariables } from "../middleware/better-auth.js";
import type { BotPool } from "../services/bot-pool.js";
import type { ModelCapabilityService } from "../services/model-capability-service.js";
import { botsRoutes, type MemoryConsolidationPreviewPort } from "./bots.js";

vi.hoisted(() => {
  process.env.DATABASE_URL ||= "postgresql://localhost/cos_tool_bot_test";
  process.env.BETTER_AUTH_SECRET ||= "test-secret";
  process.env.AUTH_OWNER_EMAIL ||= "owner@example.com";
  process.env.ENCRYPTION_KEY ||= "test-encryption-key";
});

const previewHistoricalBatches = vi.fn();
const previewPort: MemoryConsolidationPreviewPort = { previewHistoricalBatches, review: vi.fn() };

function appForRole(role: string) {
  return new Hono<{ Variables: AuthVariables }>()
    .use("*", async (c, next) => {
      c.set("authMember", { id: "member", userId: "user", organizationId: "org", role });
      await next();
    })
    .route(
      "/bots",
      botsRoutes(
        {} as Database,
        {} as BotPool,
        {} as ModelCapabilityService,
        undefined,
        undefined,
        previewPort,
      ),
    );
}

const path = "/bots/bot-a/memories/consolidation-preview";

describe("historical memory consolidation preview route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    previewHistoricalBatches.mockResolvedValue({
      data: [
        {
          botId: "bot-a",
          cursorMessageId: 40,
          processed: false,
          chatId: -1001,
          messageIds: [51, 52],
          participantIds: [7],
          excerpts: ["Earlier message", "Follow-up"],
        },
      ],
      nextAfterMessageId: 52,
    });
  });

  it("authorizes before reading and allows owner or admin", async () => {
    for (const role of ["viewer", "editor"]) {
      const denied = await appForRole(role).request(path);
      expect(denied.status).toBe(403);
    }
    expect(previewHistoricalBatches).not.toHaveBeenCalled();

    for (const role of ["owner", "admin"]) {
      const response = await appForRole(role).request(path);
      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toMatchObject({
        ok: true,
        data: [{ botId: "bot-a" }],
        nextAfterMessageId: 52,
      });
    }
    expect(previewHistoricalBatches).toHaveBeenCalledTimes(2);
    expect(previewHistoricalBatches).toHaveBeenLastCalledWith("bot-a", {});
  });

  it("forwards validated, bounded query parameters", async () => {
    const response = await appForRole("admin").request(`${path}?afterMessageId=0&limit=5`);

    expect(response.status).toBe(200);
    expect(previewHistoricalBatches).toHaveBeenCalledWith("bot-a", {
      afterMessageId: 0,
      limit: 5,
    });
  });

  it("rejects invalid cursor and batch limits before reading", async () => {
    for (const query of [
      "afterMessageId=-1",
      "afterMessageId=1.5",
      "afterMessageId=9007199254740992",
      "limit=0",
      "limit=6",
    ]) {
      const response = await appForRole("owner").request(`${path}?${query}`);
      expect(response.status, query).toBe(400);
    }
    expect(previewHistoricalBatches).not.toHaveBeenCalled();
  });
});

describe("group memory review", () => {
  const body = { chatId: "-123", start: "2026-01-01T00:00:00Z", end: "2026-01-08T00:00:00Z" };
  const review = (role: string, parameters = body) =>
    appForRole(role).request("/bots/bot-a/memory/review", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(parameters),
    });

  it("validates the group and interval before invoking the owner-only or admin-only operation", async () => {
    vi.clearAllMocks();
    expect((await review("editor")).status).toBe(403);
    expect((await appForRole("viewer").request("/bots/bot-a/memory/review")).status).toBe(403);
    for (const invalid of [
      { chatId: "123" },
      { chatId: "-9007199254740992" },
      { end: body.start },
    ]) {
      expect((await review("admin", { ...body, ...invalid })).status).toBe(400);
    }
    expect(previewPort.review).not.toHaveBeenCalled();
    const result = {
      nextAfterMessageId: null,
      calls: 1,
      changes: 0,
      inputTokens: 100,
      outputTokens: 5,
    };
    vi.mocked(previewPort.review).mockResolvedValue(result);
    const response = await review("admin");
    expect(await response.json()).toEqual({ ok: true, data: result });
    expect(previewPort.review).toHaveBeenCalledWith(
      "bot-a",
      -123,
      new Date(body.start),
      new Date(body.end),
      undefined,
    );
  });
});
