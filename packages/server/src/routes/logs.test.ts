import type { Database } from "@cos-tool-bot/database";
import type { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { Hono } from "hono";
import { SSEStreamingApi } from "hono/streaming";
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

it.each(["initial query", "poll query", "batch write"] as const)(
  "stops log streaming when disconnected during the %s",
  async (stage) => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const limit = vi.fn(async () => {
      const initial = limit.mock.calls.length === 1;
      if ((initial && stage === "initial query") || (!initial && stage === "poll query"))
        await gate;
      return initial
        ? [{ id: 7 }]
        : [
            { id: 8, message: "first" },
            { id: 9, message: "second" },
          ];
    });
    const builder = {
      from: () => builder,
      where: () => builder,
      orderBy: () => builder,
      limit,
    };
    const select = vi.fn(() => builder);
    const app = new Hono().route("/logs", logRoutes({ select } as unknown as Database));
    const originalWrite = SSEStreamingApi.prototype.writeSSE;
    const writes = vi.spyOn(SSEStreamingApi.prototype, "writeSSE");
    if (stage === "batch write") {
      writes.mockImplementation(async function (this: SSEStreamingApi, message) {
        await originalWrite.call(this, message);
        if (writes.mock.calls.length === 1) await gate;
      });
    }
    let finished!: () => void;
    const completion = new Promise<void>((resolve) => {
      finished = resolve;
    });
    const originalClose = SSEStreamingApi.prototype.close;
    const close = vi
      .spyOn(SSEStreamingApi.prototype, "close")
      .mockImplementation(async function (this: SSEStreamingApi) {
        try {
          await originalClose.call(this);
        } finally {
          finished();
        }
      });
    const response = await app.request(`/logs/stream?botId=${BOT_ID}`);
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    try {
      if (stage === "batch write") {
        reader = response.body!.getReader();
        const first = await reader.read();
        expect(new TextDecoder().decode(first.value)).toContain("id: 8");
        expect(new TextDecoder().decode(first.value)).toContain("first");
      } else {
        await vi.waitFor(() =>
          expect(limit).toHaveBeenCalledTimes(stage === "initial query" ? 1 : 2),
        );
      }
      await (reader ? reader.cancel() : response.body!.cancel());
      release();
      await completion;
      expect(writes).toHaveBeenCalledTimes(stage === "batch write" ? 1 : 0);
      expect(select).toHaveBeenCalledTimes(stage === "initial query" ? 1 : 2);
    } finally {
      await (reader ? reader.cancel() : response.body!.cancel());
      release();
      await completion;
      writes.mockRestore();
      close.mockRestore();
    }
  },
);

it("does not start log queries for a request already disconnected", async () => {
  const limit = vi.fn(async () => []);
  const builder = { from: () => builder, where: () => builder, orderBy: () => builder, limit };
  const select = vi.fn(() => builder);
  const app = new Hono().route("/logs", logRoutes({ select } as unknown as Database));
  const response = await app.request("/logs/stream", { signal: AbortSignal.abort() });
  await response.body?.cancel();
  expect(response.status).toBe(499);
  expect(select).not.toHaveBeenCalled();
});
