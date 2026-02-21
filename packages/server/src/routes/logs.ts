import type { Database } from "@cos-tool-bot/database";
import { botLogs } from "@cos-tool-bot/database";
import { count, desc, eq, gt } from "drizzle-orm";
import { Hono } from "hono";
import { streamSSE } from "hono/streaming";

export function logRoutes(db: Database) {
  return new Hono()
    .get("/", async (c) => {
      const page = Number(c.req.query("page") ?? "1");
      const limit = Number(c.req.query("limit") ?? "50");
      const level = c.req.query("level");
      const offset = (page - 1) * limit;

      const conditions = level ? eq(botLogs.level, level) : undefined;

      const [logs, [countResult]] = await Promise.all([
        db
          .select()
          .from(botLogs)
          .where(conditions)
          .orderBy(desc(botLogs.createdAt))
          .limit(limit)
          .offset(offset),
        db.select({ total: count() }).from(botLogs).where(conditions),
      ]);

      return c.json({
        ok: true as const,
        data: logs,
        total: Number(countResult?.total ?? 0),
      });
    })
    .delete("/", async (c) => {
      await db.delete(botLogs);
      return c.json({ ok: true as const });
    })
    .get("/stream", (c) => {
      return streamSSE(c, async (stream) => {
        let lastId = 0;
        let aborted = false;
        stream.onAbort(() => {
          aborted = true;
        });

        const latest = await db
          .select({ id: botLogs.id })
          .from(botLogs)
          .orderBy(desc(botLogs.id))
          .limit(1);

        if (latest[0]) {
          lastId = latest[0].id;
        }

        while (!aborted) {
          const newLogs = await db
            .select()
            .from(botLogs)
            .where(lastId > 0 ? gt(botLogs.id, lastId) : undefined)
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
