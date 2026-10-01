import type { Database } from "@cos-tool-bot/database";
import { Hono } from "hono";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AuthVariables } from "../middleware/better-auth.js";
import type { BotPool } from "../services/bot-pool.js";
import type { ModelCapabilityService } from "../services/model-capability-service.js";
import { botsRoutes } from "./bots.js";

vi.hoisted(() => {
  process.env.DATABASE_URL ||= "postgresql://localhost/cos_tool_bot_test";
  process.env.BETTER_AUTH_SECRET ||= "test-secret";
  process.env.AUTH_OWNER_EMAIL ||= "owner@example.com";
  process.env.ENCRYPTION_KEY ||= "test-encryption-key";
});

const previewConversationSummaryCleanup = vi.fn();
const cleanupConversationSummaryBatch = vi.fn();
const editActiveConversationSummary = vi.fn();
const deleteConversationSummary = vi.fn();
const botPool = {
  getConversationStore: () => ({
    previewConversationSummaryCleanup,
    cleanupConversationSummaryBatch,
    editActiveConversationSummary,
    deleteConversationSummary,
  }),
} as unknown as BotPool;

function appForRole(role: string) {
  return new Hono<{ Variables: AuthVariables }>()
    .use("*", async (c, next) => {
      c.set("authMember", { id: "member", userId: "user", organizationId: "org", role });
      await next();
    })
    .route("/bots", botsRoutes({} as Database, botPool, {} as ModelCapabilityService));
}

beforeEach(() => {
  vi.clearAllMocks();
  previewConversationSummaryCleanup.mockResolvedValue({
    activeSummaryId: 3,
    totalCount: 9,
    retainedIds: [9, 8, 7, 3],
    eligibleCount: 5,
    batchMax: 100,
  });
  cleanupConversationSummaryBatch.mockResolvedValue({ deletedCount: 2, remainingCount: 7 });
  editActiveConversationSummary.mockResolvedValue({
    id: 10,
    createdAt: "2026-09-24T00:00:00.000Z",
  });
  deleteConversationSummary.mockResolvedValue("deleted");
});

describe("conversation summary management routes", () => {
  const base = "/bots/bot-a/conversations/42/summaries";

  it("provides a read-only scoped cleanup preview", async () => {
    const response = await appForRole("viewer").request(`${base}/cleanup-preview`);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ ok: true, activeSummaryId: 3, eligibleCount: 5 });
    expect(previewConversationSummaryCleanup).toHaveBeenCalledWith("bot-a", 42);
    expect(cleanupConversationSummaryBatch).not.toHaveBeenCalled();
  });

  it("bounds cleanup and forwards the expected active version", async () => {
    const denied = await appForRole("viewer").request(`${base}/cleanup-batch`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ expectedActiveSummaryId: 3, limit: 2 }),
    });
    expect(denied.status).toBe(403);
    expect(cleanupConversationSummaryBatch).not.toHaveBeenCalled();

    const app = appForRole("owner");
    const invalid = await app.request(`${base}/cleanup-batch`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ expectedActiveSummaryId: 3, limit: 101 }),
    });
    expect(invalid.status).toBe(400);
    expect(cleanupConversationSummaryBatch).not.toHaveBeenCalled();

    const response = await app.request(`${base}/cleanup-batch`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ expectedActiveSummaryId: 3, limit: 2 }),
    });
    expect(response.status).toBe(200);
    expect(cleanupConversationSummaryBatch).toHaveBeenCalledWith({
      botId: "bot-a",
      chatId: 42,
      expectedActiveSummaryId: 3,
      limit: 2,
    });
  });

  it("returns a conflict for stale edits and rejects unauthorized edits", async () => {
    const body = JSON.stringify({ expectedActiveSummaryId: 3, content: "Corrected" });
    const request = { method: "PATCH", headers: { "content-type": "application/json" }, body };
    const denied = await appForRole("viewer").request(`${base}/active`, request);
    expect(denied.status).toBe(403);
    expect(editActiveConversationSummary).not.toHaveBeenCalled();

    editActiveConversationSummary.mockResolvedValueOnce(null);
    const stale = await appForRole("owner").request(`${base}/active`, request);
    expect(stale.status).toBe(409);
    const edited = await appForRole("owner").request(`${base}/active`, request);
    expect(edited.status).toBe(200);
    expect(editActiveConversationSummary).toHaveBeenLastCalledWith({
      botId: "bot-a",
      chatId: 42,
      expectedActiveSummaryId: 3,
      content: "Corrected",
    });
  });

  it("restricts individual summary deletion to owners and admins", async () => {
    for (const role of ["viewer", "editor"]) {
      const denied = await appForRole(role).request(`${base}/7`, { method: "DELETE" });
      expect(denied.status).toBe(403);
    }
    expect(deleteConversationSummary).not.toHaveBeenCalled();

    for (const role of ["owner", "admin"]) {
      const response = await appForRole(role).request(`${base}/7`, { method: "DELETE" });
      expect(response.status).toBe(200);
    }
    expect(deleteConversationSummary).toHaveBeenCalledTimes(2);
    expect(deleteConversationSummary).toHaveBeenCalledWith("bot-a", 42, 7);
  });
});
