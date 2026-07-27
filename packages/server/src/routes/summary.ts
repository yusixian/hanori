import { zValidator } from "@hono/zod-validator";
import { and, desc, eq, sql } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";
import type { Database } from "@cos-tool-bot/database";
import { bots, chatSummaries } from "@cos-tool-bot/database";
import type { SummaryMode } from "@cos-tool-bot/shared";
import type { ChatSummaryService } from "../services/chat-summary-service.js";
import type { SummaryConfigService } from "../services/summary-config-service.js";
import {
  DEFAULT_COOLDOWN_SECONDS,
  DEFAULT_MAX_MESSAGES,
  DEFAULT_SUMMARY_SYSTEM_PROMPT,
  DEFAULT_TIMEZONE,
  DEFAULT_WINDOW_HOURS,
} from "../services/summary-prompts.js";

const accessModeSchema = z.enum(["all", "admin"]);
const timezoneSchema = z
  .string()
  .min(1)
  .max(64)
  .refine((value) => {
    try {
      new Intl.DateTimeFormat("en", { timeZone: value });
      return true;
    } catch {
      return false;
    }
  });

const createConfigSchema = z.object({
  chatId: z.number().int(),
  isActive: z.boolean().optional(),
  scheduleHour: z.number().int().min(0).max(23).nullable().optional(),
  scheduleMinute: z.number().int().min(0).max(59).nullable().optional(),
  timezone: timezoneSchema.nullable().optional(),
  windowHours: z.number().int().min(1).max(72).optional(),
  customPrompt: z.string().nullable().optional(),
  providerId: z.string().nullable().optional(),
  modelId: z.string().nullable().optional(),
  maxMessages: z.number().int().min(10).max(2000).nullable().optional(),
  cooldownSeconds: z.number().int().min(0).max(86400).nullable().optional(),
  accessMode: accessModeSchema.optional(),
});

const updateConfigSchema = createConfigSchema.partial().omit({ chatId: true }).extend({
  chatId: z.number().int().optional(),
});

const idParamSchema = z.object({
  botId: z.string(),
  id: z.coerce.number().int().positive(),
});

const botIdParamSchema = z.object({
  botId: z.string(),
});

const triggerBodySchema = z.object({
  mode: z
    .discriminatedUnion("kind", [
      z.object({ kind: z.literal("default") }),
      z.object({ kind: z.literal("recent"), count: z.number().int().min(1).max(2000) }),
      z.object({ kind: z.literal("hours"), hours: z.number().int().min(1).max(72) }),
      z.object({ kind: z.literal("date"), day: z.enum(["today", "yesterday"]) }),
    ])
    .default({ kind: "default" }),
});

const historyQuerySchema = z.object({
  chatId: z.coerce.number().int().optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

const notFound = { ok: false as const, error: "Not found" } as const;

export function summaryRoutes(
  db: Database,
  summaryService: ChatSummaryService,
  configService: SummaryConfigService,
) {
  async function requireConfig(botId: string, id: number) {
    return configService.get(botId, id);
  }

  return new Hono()
    .get("/:botId/summary/defaults", zValidator("param", botIdParamSchema), async (c) => {
      const { botId } = c.req.valid("param");
      const [row] = await db
        .select({ aiConfig: bots.aiConfig })
        .from(bots)
        .where(eq(bots.id, botId));
      const sc = row?.aiConfig?.summaryConfig;
      return c.json({
        ok: true as const,
        data: {
          systemPrompt: sc?.systemPrompt ?? DEFAULT_SUMMARY_SYSTEM_PROMPT,
          windowHours: sc?.defaultWindowHours ?? DEFAULT_WINDOW_HOURS,
          maxMessages: sc?.defaultMaxMessages ?? DEFAULT_MAX_MESSAGES,
          cooldownSeconds: sc?.defaultCooldownSeconds ?? DEFAULT_COOLDOWN_SECONDS,
          timezone: sc?.timezone ?? DEFAULT_TIMEZONE,
        },
      });
    })
    .get("/:botId/summary/configs", zValidator("param", botIdParamSchema), async (c) => {
      const { botId } = c.req.valid("param");
      const data = await configService.list(botId);
      return c.json({ ok: true as const, data });
    })
    .post(
      "/:botId/summary/configs",
      zValidator("param", botIdParamSchema),
      zValidator("json", createConfigSchema),
      async (c) => {
        const { botId } = c.req.valid("param");
        const body = c.req.valid("json");
        const row = await configService.create({ botId, ...body });
        return c.json({ ok: true as const, data: row });
      },
    )
    .get("/:botId/summary/configs/:id", zValidator("param", idParamSchema), async (c) => {
      const { botId, id } = c.req.valid("param");
      const row = await requireConfig(botId, id);
      if (!row) return c.json(notFound, 404);
      return c.json({ ok: true as const, data: row });
    })
    .patch(
      "/:botId/summary/configs/:id",
      zValidator("param", idParamSchema),
      zValidator("json", updateConfigSchema),
      async (c) => {
        const { botId, id } = c.req.valid("param");
        const body = c.req.valid("json");
        const row = await configService.update(botId, id, body);
        if (!row) return c.json(notFound, 404);
        return c.json({ ok: true as const, data: row });
      },
    )
    .delete("/:botId/summary/configs/:id", zValidator("param", idParamSchema), async (c) => {
      const { botId, id } = c.req.valid("param");
      const ok = await configService.delete(botId, id);
      if (!ok) return c.json(notFound, 404);
      return c.json({ ok: true as const, data: { deleted: true } });
    })
    .post(
      "/:botId/summary/configs/:id/trigger",
      zValidator("param", idParamSchema),
      zValidator("json", triggerBodySchema),
      async (c) => {
        const { botId, id } = c.req.valid("param");
        const cfg = await requireConfig(botId, id);
        if (!cfg) return c.json(notFound, 404);
        const { mode } = c.req.valid("json");
        const result = await summaryService.triggerManual({
          botId: cfg.botId,
          chatId: cfg.chatId,
          userId: 0,
          mode: mode as SummaryMode,
          bypassCooldown: true,
        });
        return c.json({ ok: true as const, data: result });
      },
    )
    .get(
      "/:botId/summary/history",
      zValidator("param", botIdParamSchema),
      zValidator("query", historyQuerySchema),
      async (c) => {
        const { botId } = c.req.valid("param");
        const { chatId, page, limit } = c.req.valid("query");
        const conditions = [eq(chatSummaries.botId, botId)];
        if (chatId !== undefined) conditions.push(eq(chatSummaries.chatId, chatId));
        const [countRow] = await db
          .select({ total: sql<number>`count(*)::int` })
          .from(chatSummaries)
          .where(and(...conditions));
        const rows = await db
          .select()
          .from(chatSummaries)
          .where(and(...conditions))
          .orderBy(desc(chatSummaries.createdAt))
          .limit(limit)
          .offset((page - 1) * limit);
        return c.json({
          ok: true as const,
          data: rows.map((r) => ({
            ...r,
            windowStart: r.windowStart.toISOString(),
            windowEnd: r.windowEnd.toISOString(),
            createdAt: r.createdAt.toISOString(),
          })),
          total: countRow?.total ?? 0,
          page,
          limit,
        });
      },
    )
    .get("/:botId/summary/history/:id", zValidator("param", idParamSchema), async (c) => {
      const { botId, id } = c.req.valid("param");
      const [row] = await db
        .select()
        .from(chatSummaries)
        .where(and(eq(chatSummaries.id, id), eq(chatSummaries.botId, botId)));
      if (!row) return c.json(notFound, 404);
      return c.json({
        ok: true as const,
        data: {
          ...row,
          windowStart: row.windowStart.toISOString(),
          windowEnd: row.windowEnd.toISOString(),
          createdAt: row.createdAt.toISOString(),
        },
      });
    })
    .delete("/:botId/summary/history/:id", zValidator("param", idParamSchema), async (c) => {
      const { botId, id } = c.req.valid("param");
      const deleted = await db
        .delete(chatSummaries)
        .where(and(eq(chatSummaries.id, id), eq(chatSummaries.botId, botId)))
        .returning({ id: chatSummaries.id });
      if (deleted.length === 0) return c.json(notFound, 404);
      return c.json({ ok: true as const, data: { deleted: true } });
    });
}
