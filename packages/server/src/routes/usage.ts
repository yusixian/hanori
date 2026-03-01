import type { Database } from "@cos-tool-bot/database";
import { bots, tokenUsage } from "@cos-tool-bot/database";
import { and, desc, eq, gte, lte, sql, sum, count } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import { Hono } from "hono";

function parseDate(value: string | undefined): Date | undefined {
  if (!value) return undefined;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? undefined : d;
}

export function usageRoutes(db: Database) {
  return new Hono()
    .get("/summary", async (c) => {
      const botId = c.req.query("botId");
      const from = parseDate(c.req.query("from"));
      const to = parseDate(c.req.query("to"));

      const conditions: SQL[] = [];
      if (botId) conditions.push(eq(tokenUsage.botId, botId));
      if (from) conditions.push(gte(tokenUsage.createdAt, from));
      if (to) conditions.push(lte(tokenUsage.createdAt, to));
      const where = conditions.length > 0 ? and(...conditions) : undefined;

      const [result] = await db
        .select({
          totalTokens: sum(tokenUsage.totalTokens).mapWith(Number),
          promptTokens: sum(tokenUsage.promptTokens).mapWith(Number),
          completionTokens: sum(tokenUsage.completionTokens).mapWith(Number),
          requestCount: count(),
        })
        .from(tokenUsage)
        .where(where);

      return c.json({
        ok: true as const,
        data: {
          totalTokens: result?.totalTokens ?? 0,
          promptTokens: result?.promptTokens ?? 0,
          completionTokens: result?.completionTokens ?? 0,
          requestCount: result?.requestCount ?? 0,
        },
      });
    })
    .get("/trend", async (c) => {
      const botId = c.req.query("botId");
      const from = parseDate(c.req.query("from"));
      const to = parseDate(c.req.query("to"));
      const granularity = c.req.query("granularity") ?? "day";

      const validGranularity = ["hour", "day", "week", "month"].includes(granularity)
        ? granularity
        : "day";

      const conditions: SQL[] = [];
      if (botId) conditions.push(eq(tokenUsage.botId, botId));
      if (from) conditions.push(gte(tokenUsage.createdAt, from));
      if (to) conditions.push(lte(tokenUsage.createdAt, to));
      const where = conditions.length > 0 ? and(...conditions) : undefined;

      const bucket = sql<string>`date_trunc(${sql.raw(`'${validGranularity}'`)}, ${tokenUsage.createdAt})`;

      const rows = await db
        .select({
          bucket,
          promptTokens: sum(tokenUsage.promptTokens).mapWith(Number),
          completionTokens: sum(tokenUsage.completionTokens).mapWith(Number),
          totalTokens: sum(tokenUsage.totalTokens).mapWith(Number),
          requestCount: count(),
        })
        .from(tokenUsage)
        .where(where)
        .groupBy(bucket)
        .orderBy(bucket);

      return c.json({
        ok: true as const,
        data: rows.map((r) => ({
          date: r.bucket,
          promptTokens: r.promptTokens ?? 0,
          completionTokens: r.completionTokens ?? 0,
          totalTokens: r.totalTokens ?? 0,
          requestCount: r.requestCount ?? 0,
        })),
      });
    })
    .get("/by-model", async (c) => {
      const botId = c.req.query("botId");
      const from = parseDate(c.req.query("from"));
      const to = parseDate(c.req.query("to"));

      const conditions: SQL[] = [];
      if (botId) conditions.push(eq(tokenUsage.botId, botId));
      if (from) conditions.push(gte(tokenUsage.createdAt, from));
      if (to) conditions.push(lte(tokenUsage.createdAt, to));
      const where = conditions.length > 0 ? and(...conditions) : undefined;

      const rows = await db
        .select({
          model: tokenUsage.model,
          totalTokens: sum(tokenUsage.totalTokens).mapWith(Number),
          promptTokens: sum(tokenUsage.promptTokens).mapWith(Number),
          completionTokens: sum(tokenUsage.completionTokens).mapWith(Number),
          requestCount: count(),
        })
        .from(tokenUsage)
        .where(where)
        .groupBy(tokenUsage.model)
        .orderBy(desc(sum(tokenUsage.totalTokens)));

      return c.json({
        ok: true as const,
        data: rows.map((r) => ({
          model: r.model,
          totalTokens: r.totalTokens ?? 0,
          promptTokens: r.promptTokens ?? 0,
          completionTokens: r.completionTokens ?? 0,
          requestCount: r.requestCount ?? 0,
        })),
      });
    })
    .get("/by-bot", async (c) => {
      const from = parseDate(c.req.query("from"));
      const to = parseDate(c.req.query("to"));

      const conditions: SQL[] = [];
      if (from) conditions.push(gte(tokenUsage.createdAt, from));
      if (to) conditions.push(lte(tokenUsage.createdAt, to));
      const where = conditions.length > 0 ? and(...conditions) : undefined;

      const rows = await db
        .select({
          botId: tokenUsage.botId,
          botName: bots.name,
          totalTokens: sum(tokenUsage.totalTokens).mapWith(Number),
          promptTokens: sum(tokenUsage.promptTokens).mapWith(Number),
          completionTokens: sum(tokenUsage.completionTokens).mapWith(Number),
          requestCount: count(),
        })
        .from(tokenUsage)
        .innerJoin(bots, eq(tokenUsage.botId, bots.id))
        .where(where)
        .groupBy(tokenUsage.botId, bots.name)
        .orderBy(desc(sum(tokenUsage.totalTokens)));

      return c.json({
        ok: true as const,
        data: rows.map((r) => ({
          botId: r.botId,
          botName: r.botName,
          totalTokens: r.totalTokens ?? 0,
          promptTokens: r.promptTokens ?? 0,
          completionTokens: r.completionTokens ?? 0,
          requestCount: r.requestCount ?? 0,
        })),
      });
    });
}
