import type { Database } from "@cos-tool-bot/database";
import { drizzle } from "drizzle-orm/pg-proxy";
import { Hono } from "hono";
import { expect, it, vi } from "vitest";
import type { BotPool } from "../services/bot-pool.js";
import type { ModelCapabilityService } from "../services/model-capability-service.js";
import { botsRoutes } from "./bots.js";

vi.hoisted(() => {
  process.env.DATABASE_URL ||= "postgresql://localhost/cos_tool_bot_test";
  process.env.BETTER_AUTH_SECRET ||= "test-secret";
  process.env.AUTH_OWNER_EMAIL ||= "owner@example.com";
});

it("uses a deterministic creation order and ID tie-breaker across Bot pages", async () => {
  const queries: Array<{ sql: string; params: unknown[] }> = [];
  const db = drizzle(async (sql, params) => {
    queries.push({ sql, params });
    return { rows: sql.includes("count(*)") ? [[125]] : [] };
  });
  const app = new Hono().route(
    "/bots",
    botsRoutes(db as unknown as Database, {} as BotPool, {} as ModelCapabilityService),
  );

  for (const page of [1, 11]) {
    const response = await app.request(`/bots?page=${page}&limit=12`);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ ok: true, total: 125 });
  }

  const pageQueries = queries.filter(({ sql }) => !sql.includes("count(*)"));
  expect(pageQueries).toHaveLength(2);
  for (const { sql } of pageQueries) {
    expect(sql).toContain('order by "bots"."created_at" asc, "bots"."id" asc');
  }
  expect(pageQueries[0]!.params).toEqual([12]);
  expect(pageQueries[1]!.params).toEqual([12, 120]);
});
