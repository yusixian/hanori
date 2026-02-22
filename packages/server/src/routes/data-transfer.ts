import type { Database } from "@cos-tool-bot/database";
import type { ExportPayload } from "@cos-tool-bot/shared";
import { zValidator } from "@hono/zod-validator";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod";
import { DataTransferService } from "../services/data-transfer.js";

export function dataTransferRoutes(db: Database, encryptionKey: string) {
  const service = new DataTransferService(db, encryptionKey);

  return new Hono()
    .get("/:botId/export/stats", async (c) => {
      const botId = c.req.param("botId");
      try {
        const stats = await service.getExportStats(botId);
        return c.json({ ok: true as const, data: stats });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return c.json({ ok: false as const, error: msg }, 400);
      }
    })
    .get(
      "/:botId/export",
      zValidator(
        "query",
        z.object({
          excludeTables: z.string().optional(),
        }),
      ),
      async (c) => {
        const botId = c.req.param("botId");
        const { excludeTables } = c.req.valid("query");
        const excludeSet = excludeTables
          ? new Set(excludeTables.split(",").map((s) => s.trim()))
          : undefined;

        try {
          const payload = await service.exportBot(botId, excludeSet);
          return c.json({ ok: true as const, data: payload });
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          return c.json({ ok: false as const, error: msg }, 400);
        }
      },
    )
    .post("/import", bodyLimit({ maxSize: 50 * 1024 * 1024 }), async (c) => {
      try {
        const body = await c.req.json<ExportPayload>();
        const result = await service.importData(body);
        return c.json({ ok: true as const, data: result });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return c.json({ ok: false as const, error: msg }, 400);
      }
    });
}
