import { bots, type Database } from "@cos-tool-bot/database";
import type { ExportPayload } from "@cos-tool-bot/shared";
import { zValidator } from "@hono/zod-validator";
import { and, eq } from "drizzle-orm";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { gunzipSync, gzipSync } from "node:zlib";
import superjson from "superjson";
import { z } from "zod";
import { DataTransferService } from "../services/data-transfer.js";

export function dataTransferRoutes(db: Database, encryptionKey: string) {
  const service = new DataTransferService(db, encryptionKey);

  return new Hono()
    .get("/:botId/export/stats", async (c) => {
      const botId = c.req.param("botId");
      const [bot] = await db
        .select()
        .from(bots)
        .where(and(eq(bots.id, botId), eq(bots.platform, "telegram")));
      if (!bot) return c.json({ ok: false as const, error: "Bot not found" }, 404);

      try {
        const stats = await service.getExportStats(botId);
        const body = superjson.stringify({ ok: true as const, data: stats });
        return c.body(body, 200, { "Content-Type": "application/superjson" });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        const body = superjson.stringify({ ok: false as const, error: msg });
        return c.body(body, 400, { "Content-Type": "application/superjson" });
      }
    })
    .get(
      "/:botId/export",
      zValidator(
        "query",
        z.object({
          excludeTables: z.string().optional(),
          format: z.enum(["json", "gzip"]).optional(),
        }),
      ),
      async (c) => {
        const botId = c.req.param("botId");
        const [bot] = await db
          .select()
          .from(bots)
          .where(and(eq(bots.id, botId), eq(bots.platform, "telegram")));
        if (!bot) return c.json({ ok: false as const, error: "Bot not found" }, 404);

        const { excludeTables, format } = c.req.valid("query");
        const excludeSet = excludeTables
          ? new Set(excludeTables.split(",").map((s) => s.trim()))
          : undefined;

        try {
          const payload = await service.exportBot(botId, excludeSet);

          const botName = (bot.name ?? "bot").replace(/[^a-zA-Z0-9_-]/g, "_");
          const date = new Date().toISOString().slice(0, 10);

          if (format === "gzip") {
            const compressed = gzipSync(JSON.stringify(payload));
            return c.body(compressed, 200, {
              "Content-Type": "application/gzip",
              "Content-Disposition": `attachment; filename="cos-tool-bot_${botName}_${date}.json.gz"`,
            });
          }

          const body = JSON.stringify(payload, null, 2);
          return c.body(body, 200, {
            "Content-Type": "application/json",
            "Content-Disposition": `attachment; filename="cos-tool-bot_${botName}_${date}.json"`,
          });
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          const body = superjson.stringify({ ok: false as const, error: msg });
          return c.body(body, 400, { "Content-Type": "application/superjson" });
        }
      },
    )
    .post("/import", bodyLimit({ maxSize: 50 * 1024 * 1024 }), async (c) => {
      try {
        const buf = await c.req.arrayBuffer();
        const bytes = new Uint8Array(buf);

        let body: ExportPayload;
        let text: string;
        // Detect gzip magic bytes (0x1f, 0x8b)
        if (bytes.length >= 2 && bytes[0] === 0x1f && bytes[1] === 0x8b) {
          text = gunzipSync(Buffer.from(buf)).toString("utf-8");
        } else {
          text = new TextDecoder().decode(bytes);
        }
        // Try plain JSON first, fall back to superjson for backward compatibility
        try {
          body = JSON.parse(text) as ExportPayload;
        } catch {
          body = superjson.parse<ExportPayload>(text);
        }

        const result = await service.importData(body);
        const resBody = superjson.stringify({ ok: true as const, data: result });
        return c.body(resBody, 200, { "Content-Type": "application/superjson" });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        const resBody = superjson.stringify({ ok: false as const, error: msg });
        return c.body(resBody, 400, { "Content-Type": "application/superjson" });
      }
    });
}
