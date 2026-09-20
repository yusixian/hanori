import type { Database } from "@cos-tool-bot/database";
import type { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import { logRoutes } from "./logs.js";

const BOT_ID = "00000000-0000-4000-8000-000000000001";

function listDatabase() {
  let whereCondition: SQL | undefined;
  const orderBy = vi.fn();
  const listRows = [
    {
      id: 7,
      botId: BOT_ID,
      level: "error",
      message: "failed",
      meta: { chatId: -100, correlationId: "corr-1" },
      botRunId: null,
      createdAt: new Date("2026-09-21T00:00:00.000Z"),
    },
  ];
  const listBuilder = {
    from: vi.fn(() => listBuilder),
    where: vi.fn((condition?: SQL) => {
      whereCondition = condition;
      return listBuilder;
    }),
    orderBy: (...expressions: SQL[]) => {
      orderBy(...expressions);
      return listBuilder;
    },
    limit: vi.fn(() => listBuilder),
    offset: vi.fn(async () => listRows),
  };
  const countBuilder = {
    from: vi.fn(() => countBuilder),
    where: vi.fn(async () => [{ total: 1 }]),
  };
  const select = vi
    .fn()
    .mockImplementationOnce(() => listBuilder)
    .mockImplementationOnce(() => countBuilder);
  return {
    db: { select } as unknown as Database,
    select,
    listBuilder,
    orderBy,
    getWhere: () => whereCondition,
  };
}

describe("log routes", () => {
  it("combines bot, message/meta search, chat, and correlation filters", async () => {
    const fixture = listDatabase();
    const app = new Hono().route("/logs", logRoutes(fixture.db));

    const response = await app.request(
      `/logs?page=2&limit=25&level=error&botId=${BOT_ID}&search=trace%25&chatId=-100&correlationId=corr-1`,
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ ok: true, total: 1 });
    expect(fixture.listBuilder.limit).toHaveBeenCalledWith(25);
    expect(fixture.listBuilder.offset).toHaveBeenCalledWith(25);

    const compiled = new PgDialect().sqlToQuery(fixture.getWhere()!);
    expect(compiled.sql).toContain('"bot_logs"."bot_id" =');
    expect(compiled.sql).toContain('"bot_logs"."message" ilike');
    expect(compiled.sql).toContain('"bot_logs"."meta"::text ILIKE');
    expect(compiled.sql).toContain("->> 'chatId'");
    expect(compiled.sql).toContain("->> 'correlationId'");
    expect(compiled.params).toEqual([
      "error",
      BOT_ID,
      "%trace\\%%",
      "%trace\\%%",
      "-100",
      "corr-1",
    ]);
  });

  it("uses id as a stable tie-breaker for paginated rows", async () => {
    const fixture = listDatabase();
    const app = new Hono().route("/logs", logRoutes(fixture.db));

    expect((await app.request("/logs")).status).toBe(200);

    const dialect = new PgDialect();
    const orderSql = fixture.orderBy.mock.calls[0]!.map(
      (expression) => dialect.sqlToQuery(expression as SQL).sql,
    );
    expect(orderSql).toEqual(['"bot_logs"."created_at" desc', '"bot_logs"."id" desc']);
  });

  it("rejects invalid pagination and structured filters before querying", async () => {
    const fixture = listDatabase();
    const app = new Hono().route("/logs", logRoutes(fixture.db));

    expect((await app.request("/logs?page=0")).status).toBe(400);
    expect((await app.request("/logs?limit=201")).status).toBe(400);
    expect((await app.request("/logs?chatId=not-a-chat")).status).toBe(400);
    expect((await app.request("/logs?correlationId=")).status).toBe(400);
    expect(fixture.select).not.toHaveBeenCalled();
  });
});
