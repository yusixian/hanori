import type { Database } from "@cos-tool-bot/database";
import { pixaiGenerations } from "@cos-tool-bot/database";
import { getDataDir } from "@cos-tool-bot/shared";
import { zValidator } from "@hono/zod-validator";
import { and, count, desc, eq } from "drizzle-orm";
import { Hono } from "hono";
import { unlink } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";

export function generationRoutes(db: Database) {
  return new Hono()
    .get(
      "/:botId/generations",
      zValidator(
        "query",
        z.object({
          page: z.coerce.number().int().positive().optional().default(1),
          pageSize: z.coerce.number().int().positive().max(100).optional().default(20),
          status: z.enum(["pending", "completed", "failed"]).optional(),
          chatId: z.coerce.number().optional(),
        }),
      ),
      async (c) => {
        const botId = c.req.param("botId");
        const { page, pageSize, status, chatId } = c.req.valid("query");

        const conditions = [eq(pixaiGenerations.botId, botId)];
        if (status) conditions.push(eq(pixaiGenerations.status, status));
        if (chatId) conditions.push(eq(pixaiGenerations.chatId, chatId));

        const where = and(...conditions);

        const [totalResult, rows] = await Promise.all([
          db.select({ count: count() }).from(pixaiGenerations).where(where),
          db
            .select()
            .from(pixaiGenerations)
            .where(where)
            .orderBy(desc(pixaiGenerations.createdAt))
            .limit(pageSize)
            .offset((page - 1) * pageSize),
        ]);

        const total = totalResult[0]?.count ?? 0;

        const data = rows.map((row) => ({
          id: row.id,
          botId: row.botId,
          chatId: row.chatId,
          userId: row.userId,
          taskId: row.taskId,
          prompt: row.prompt,
          negativePrompt: row.negativePrompt,
          modelId: row.modelId,
          width: row.width,
          height: row.height,
          batchSize: row.batchSize,
          samplingSteps: row.samplingSteps,
          cfgScale: row.cfgScale,
          promptHelper: row.promptHelper,
          pixaiConfig: row.pixaiConfig,
          nsfwScores: row.nsfwScores,
          status: row.status,
          mediaUrls: row.mediaUrls,
          localFiles: row.localFiles ? row.localFiles.map((f) => `generations/${f}`) : null,
          errorMessage: row.errorMessage,
          durationMs: row.durationMs,
          createdAt: row.createdAt.toISOString(),
          completedAt: row.completedAt?.toISOString() ?? null,
        }));

        return c.json({ ok: true as const, data, total, page, pageSize });
      },
    )
    .delete("/:botId/generations/:generationId", async (c) => {
      const botId = c.req.param("botId");
      const generationId = Number(c.req.param("generationId"));
      if (Number.isNaN(generationId))
        return c.json({ ok: false as const, error: "Invalid generationId" }, 400);

      const [row] = await db
        .delete(pixaiGenerations)
        .where(and(eq(pixaiGenerations.id, generationId), eq(pixaiGenerations.botId, botId)))
        .returning({ localFiles: pixaiGenerations.localFiles });

      if (!row) return c.json({ ok: false as const, error: "Generation not found" }, 404);

      // Clean up local files in background
      if (row.localFiles) {
        const dataDir = getDataDir(botId);
        void Promise.all(
          row.localFiles.map((f) => unlink(join(dataDir, "generations", f)).catch(() => {})),
        );
      }

      return c.json({ ok: true as const });
    });
}
