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

interface CacheAggregate {
  requestCount: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  cacheObservedRequestCount: number;
  cacheWriteObservedRequestCount: number;
  cacheHitRequestCount: number;
  cacheObservedPromptTokens: number;
}

export function buildCacheMetrics(aggregate: CacheAggregate) {
  return {
    cacheReadTokens: aggregate.cacheReadTokens,
    cacheWriteTokens: aggregate.cacheWriteTokens,
    cacheObservedRequestCount: aggregate.cacheObservedRequestCount,
    cacheWriteObservedRequestCount: aggregate.cacheWriteObservedRequestCount,
    cacheHitRequestCount: aggregate.cacheHitRequestCount,
    cacheObservationRate:
      aggregate.requestCount > 0
        ? aggregate.cacheObservedRequestCount / aggregate.requestCount
        : null,
    cacheTokenHitRate:
      aggregate.cacheObservedPromptTokens > 0
        ? aggregate.cacheReadTokens / aggregate.cacheObservedPromptTokens
        : null,
    cacheRequestHitRate:
      aggregate.cacheObservedRequestCount > 0
        ? aggregate.cacheHitRequestCount / aggregate.cacheObservedRequestCount
        : null,
  };
}

function cacheAggregates() {
  return {
    cacheReadTokens: sql<number>`coalesce(sum(${tokenUsage.cacheReadTokens}), 0)`.mapWith(Number),
    cacheWriteTokens: sql<number>`coalesce(sum(${tokenUsage.cacheWriteTokens}), 0)`.mapWith(Number),
    cacheObservedRequestCount: count(tokenUsage.cacheReadTokens),
    cacheWriteObservedRequestCount: count(tokenUsage.cacheWriteTokens),
    cacheHitRequestCount:
      sql<number>`count(*) filter (where ${tokenUsage.cacheReadTokens} > 0)`.mapWith(Number),
    cacheObservedPromptTokens:
      sql<number>`coalesce(sum(case when ${tokenUsage.cacheReadTokens} is not null then ${tokenUsage.promptTokens} else 0 end), 0)`.mapWith(
        Number,
      ),
  };
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
          ...cacheAggregates(),
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
          ...buildCacheMetrics({
            requestCount: result?.requestCount ?? 0,
            cacheReadTokens: result?.cacheReadTokens ?? 0,
            cacheWriteTokens: result?.cacheWriteTokens ?? 0,
            cacheObservedRequestCount: result?.cacheObservedRequestCount ?? 0,
            cacheWriteObservedRequestCount: result?.cacheWriteObservedRequestCount ?? 0,
            cacheHitRequestCount: result?.cacheHitRequestCount ?? 0,
            cacheObservedPromptTokens: result?.cacheObservedPromptTokens ?? 0,
          }),
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
          ...cacheAggregates(),
        })
        .from(tokenUsage)
        .where(where)
        .groupBy(bucket)
        .orderBy(bucket);

      return c.json({
        ok: true as const,
        data: rows.map((r) => {
          const promptTokens = r.promptTokens ?? 0;
          const requestCount = r.requestCount ?? 0;
          return {
            date: r.bucket,
            promptTokens,
            completionTokens: r.completionTokens ?? 0,
            totalTokens: r.totalTokens ?? 0,
            requestCount,
            ...buildCacheMetrics({
              requestCount,
              cacheReadTokens: r.cacheReadTokens ?? 0,
              cacheWriteTokens: r.cacheWriteTokens ?? 0,
              cacheObservedRequestCount: r.cacheObservedRequestCount ?? 0,
              cacheWriteObservedRequestCount: r.cacheWriteObservedRequestCount ?? 0,
              cacheHitRequestCount: r.cacheHitRequestCount ?? 0,
              cacheObservedPromptTokens: r.cacheObservedPromptTokens ?? 0,
            }),
          };
        }),
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
