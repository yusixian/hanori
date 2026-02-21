import type { Database } from "@cos-tool-bot/database";
import { botLogs } from "@cos-tool-bot/database";
import { zValidator } from "@hono/zod-validator";
import { and, count, desc, eq, gt } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { z } from "zod";

export function logRoutes(db: Database) {
  return new Hono()
    .get("/", async (c) => {
      const page = Number(c.req.query("page") ?? "1");
      const limit = Number(c.req.query("limit") ?? "50");
      const level = c.req.query("level");
      const botId = c.req.query("botId");
      const offset = (page - 1) * limit;

      const conditions: SQL[] = [];
      if (level) conditions.push(eq(botLogs.level, level));
      if (botId) conditions.push(eq(botLogs.botId, botId));
      const where = conditions.length > 0 ? and(...conditions) : undefined;

      const [logs, [countResult]] = await Promise.all([
        db
          .select()
          .from(botLogs)
          .where(where)
          .orderBy(desc(botLogs.createdAt))
          .limit(limit)
          .offset(offset),
        db.select({ total: count() }).from(botLogs).where(where),
      ]);

      return c.json({
        ok: true as const,
        data: logs,
        total: Number(countResult?.total ?? 0),
      });
    })
    .delete(
      "/",
      zValidator("query", z.object({ botId: z.string().uuid().optional() })),
      async (c) => {
        const { botId } = c.req.valid("query");
        if (botId) {
          await db.delete(botLogs).where(eq(botLogs.botId, botId));
        } else {
          await db.delete(botLogs);
        }
        return c.json({ ok: true as const });
      },
    )
    .get("/stream", (c) => {
      const botId = c.req.query("botId");
      return streamSSE(c, async (stream) => {
        let lastId = 0;
        let aborted = false;
        stream.onAbort(() => {
          aborted = true;
        });

        const baseConditions: SQL[] = [];
        if (botId) baseConditions.push(eq(botLogs.botId, botId));

        const latest = await db
          .select({ id: botLogs.id })
          .from(botLogs)
          .where(baseConditions.length > 0 ? and(...baseConditions) : undefined)
          .orderBy(desc(botLogs.id))
          .limit(1);

        if (latest[0]) {
          lastId = latest[0].id;
        }

        while (!aborted) {
          const conditions = [...baseConditions];
          if (lastId > 0) conditions.push(gt(botLogs.id, lastId));
          const where = conditions.length > 0 ? and(...conditions) : undefined;

          const newLogs = await db
            .select()
            .from(botLogs)
            .where(where)
            .orderBy(botLogs.id)
            .limit(20);

          for (const log of newLogs) {
            await stream.writeSSE({
              data: JSON.stringify(log),
              event: "log",
              id: String(log.id),
            });
            lastId = log.id;
          }

          await stream.sleep(2000);
        }
      });
    });
}
