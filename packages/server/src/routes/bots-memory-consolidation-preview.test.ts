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
const previewPort: MemoryConsolidationPreviewPort = { previewHistoricalBatches };

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
