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

const execute = vi.fn();
const transaction = vi.fn();
const db = { execute, transaction } as unknown as Database;

function appForRole(role: string) {
  return new Hono<{ Variables: AuthVariables }>()
    .use("*", async (c, next) => {
      c.set("authMember", { id: "member", userId: "user", organizationId: "org", role });
      await next();
    })
    .route("/bots", botsRoutes(db, {} as BotPool, {} as ModelCapabilityService));
}

const base = "/bots/bot-a/memories";
const candidates = [
  {
    candidateId: 1,
    survivorId: 2,
    expectedCandidateUpdatedAt: "2026-09-23T12:00:00.000Z",
    expectedSurvivorUpdatedAt: "2026-09-24T12:00:00.000Z",
  },
];

describe("historical memory duplicate cleanup routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    execute.mockResolvedValue([]);
    transaction.mockImplementation(async (callback: (tx: unknown) => unknown) =>
      callback({
        select: () => ({
          from: () => ({ where: () => ({ orderBy: () => ({ for: async () => [] }) }) }),
        }),
      }),
    );
  });

  it("restricts preview and mutation to owner or admin", async () => {
    expect((await appForRole("viewer").request(`${base}/duplicate-preview`)).status).toBe(403);
    expect(execute).not.toHaveBeenCalled();
    const response = await appForRole("admin").request(`${base}/duplicate-preview`);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      ok: true,
      data: [],
      hasMore: false,
      batchMax: 50,
    });

    const denied = await appForRole("viewer").request(`${base}/retire-duplicates`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ candidates }),
    });
    expect(denied.status).toBe(403);
    expect(transaction).not.toHaveBeenCalled();
  });

  it("requires a bounded explicit confirmation and reports a stale preview", async () => {
    const app = appForRole("owner");
    const invalid = await app.request(`${base}/retire-duplicates`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ candidates: [] }),
    });
    expect(invalid.status).toBe(400);
    expect(transaction).not.toHaveBeenCalled();

    const repeated = await app.request(`${base}/retire-duplicates`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ candidates: [candidates[0], candidates[0]] }),
    });
    expect(repeated.status).toBe(400);
    expect(transaction).not.toHaveBeenCalled();

    const stale = await app.request(`${base}/retire-duplicates`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ candidates }),
    });
    expect(stale.status).toBe(409);
    expect(await stale.json()).toMatchObject({ error: "Memories changed; refresh preview" });
  });
});
