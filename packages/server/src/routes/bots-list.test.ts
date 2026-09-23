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

it("filters Bot names case-insensitively with literal LIKE characters before pagination and count", async () => {
  const queries: Array<{ sql: string; params: unknown[] }> = [];
  const db = drizzle(async (sql, params) => {
    queries.push({ sql, params });
    return { rows: sql.includes("count(*)") ? [[2]] : [] };
  });
  const app = new Hono().route(
    "/bots",
    botsRoutes(db as unknown as Database, {} as BotPool, {} as ModelCapabilityService),
  );

  const response = await app.request("/bots?page=2&limit=12&search=%20%20MiXeD_%25%20%20");

  expect(response.status).toBe(200);
  await expect(response.json()).resolves.toMatchObject({ ok: true, data: [], total: 2 });

  const listQuery = queries.find(({ sql }) => !sql.includes("count(*)"))!;
  const countQuery = queries.find(({ sql }) => sql.includes("count(*)"))!;
  const escapedPattern = "%MiXeD\\_\\%%";
  expect(listQuery.sql).toContain('"bots"."name" ilike');
  expect(listQuery.sql).toContain("limit $2 offset $3");
  expect(listQuery.params).toEqual([escapedPattern, 12, 12]);
  expect(countQuery.sql).toContain('"bots"."name" ilike');
  expect(countQuery.params).toEqual([escapedPattern]);
});

it("treats an empty or whitespace Bot search as unfiltered and bounds non-empty searches", async () => {
  const queries: Array<{ sql: string; params: unknown[] }> = [];
  const db = drizzle(async (sql, params) => {
    queries.push({ sql, params });
    return { rows: sql.includes("count(*)") ? [[1]] : [] };
  });
  const app = new Hono().route(
    "/bots",
    botsRoutes(db as unknown as Database, {} as BotPool, {} as ModelCapabilityService),
  );

  const response = await app.request("/bots?search=%20%20");

  expect(response.status).toBe(200);
  await expect(response.json()).resolves.toMatchObject({ ok: true, total: 1 });
  expect(queries).toHaveLength(2);
  expect(queries.every(({ sql }) => !sql.includes('"bots"."name" ilike'))).toBe(true);
  expect(queries.find(({ sql }) => !sql.includes("count(*)"))?.params).toEqual([20]);

  expect((await app.request(`/bots?search=${"a".repeat(101)}`)).status).toBe(400);
  expect((await app.request(`/bots?search=${encodeURIComponent(" ".repeat(101))}`)).status).toBe(
    400,
  );
  expect(queries).toHaveLength(2);
});
