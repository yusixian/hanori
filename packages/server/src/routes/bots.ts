import type { Database } from "@cos-tool-bot/database";
import { bots } from "@cos-tool-bot/database";
import type { BotWithStatus } from "@cos-tool-bot/shared";
import { zValidator } from "@hono/zod-validator";
import { eq } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";
import { env } from "../env.js";
import type { BotPool } from "../services/bot-pool.js";
import { decrypt, encrypt, maskToken } from "../utils/crypto.js";

const createBotSchema = z.object({
  name: z.string().min(1).max(100),
  token: z.string().min(1),
  adminChatIds: z.array(z.number()).default([]),
  isActive: z.boolean().default(true),
});

const updateBotSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  token: z.string().min(1).optional(),
  adminChatIds: z.array(z.number()).optional(),
  isActive: z.boolean().optional(),
});

function toBotWithStatus(bot: typeof bots.$inferSelect, botPool: BotPool): BotWithStatus {
  const manager = botPool.getManager(bot.id);
  const token = decrypt(bot.encryptedToken, env.ENCRYPTION_KEY);
  return {
    id: bot.id,
    name: bot.name,
    tokenMasked: maskToken(token),
    adminChatIds: bot.adminChatIds,
    isActive: bot.isActive,
    createdAt: bot.createdAt.toISOString(),
    updatedAt: bot.updatedAt?.toISOString() ?? null,
    status: manager?.status ?? "stopped",
    uptime: manager?.uptime ?? null,
  };
}

export function botsRoutes(db: Database, botPool: BotPool) {
  return new Hono()
    .get("/", async (c) => {
      const allBots = await db.select().from(bots);
      const data = allBots.map((b) => toBotWithStatus(b, botPool));
      return c.json({ ok: true as const, data });
    })
    .get("/:botId", async (c) => {
      const botId = c.req.param("botId");
      const [bot] = await db.select().from(bots).where(eq(bots.id, botId));
      if (!bot) return c.json({ ok: false as const, error: "Bot not found" }, 404);
      return c.json({ ok: true as const, data: toBotWithStatus(bot, botPool) });
    })
    .post("/", zValidator("json", createBotSchema), async (c) => {
      const body = c.req.valid("json");
      const encryptedToken = encrypt(body.token, env.ENCRYPTION_KEY);
      const rows = await db
        .insert(bots)
        .values({
          name: body.name,
          encryptedToken,
          adminChatIds: body.adminChatIds,
          isActive: body.isActive,
        })
        .returning();
      const created = rows[0]!;
      if (body.isActive) {
        try {
          await botPool.startBot(created.id);
        } catch {
          // Bot created but failed to start — still return success
        }
      }
      return c.json({ ok: true as const, data: toBotWithStatus(created, botPool) }, 201);
    })
    .put("/:botId", zValidator("json", updateBotSchema), async (c) => {
      const botId = c.req.param("botId");
      const body = c.req.valid("json");

      const [existing] = await db.select().from(bots).where(eq(bots.id, botId));
      if (!existing) return c.json({ ok: false as const, error: "Bot not found" }, 404);

      const updates: Partial<typeof bots.$inferInsert> = {};
      if (body.name !== undefined) updates.name = body.name;
      if (body.token !== undefined)
        updates.encryptedToken = encrypt(body.token, env.ENCRYPTION_KEY);
      if (body.adminChatIds !== undefined) updates.adminChatIds = body.adminChatIds;
      if (body.isActive !== undefined) updates.isActive = body.isActive;

      const rows = await db.update(bots).set(updates).where(eq(bots.id, botId)).returning();
      const updated = rows[0]!;

      // Restart running bot if token or adminChatIds changed
      const needsRestart = body.token !== undefined || body.adminChatIds !== undefined;
      const manager = botPool.getManager(botId);
      if (manager && needsRestart) {
        try {
          await botPool.restartBot(botId);
        } catch {
          // continue
        }
      }

      return c.json({ ok: true as const, data: toBotWithStatus(updated, botPool) });
    })
    .delete("/:botId", async (c) => {
      const botId = c.req.param("botId");
      const [bot] = await db.select().from(bots).where(eq(bots.id, botId));
      if (!bot) return c.json({ ok: false as const, error: "Bot not found" }, 404);
      await botPool.stopBot(botId);
      await db.delete(bots).where(eq(bots.id, botId));
      return c.json({ ok: true as const });
    })
    .post("/:botId/start", async (c) => {
      const botId = c.req.param("botId");
      const [bot] = await db.select().from(bots).where(eq(bots.id, botId));
      if (!bot) return c.json({ ok: false as const, error: "Bot not found" }, 404);
      await botPool.startBot(botId);
      return c.json({ ok: true as const });
    })
    .post("/:botId/stop", async (c) => {
      const botId = c.req.param("botId");
      await botPool.stopBot(botId);
      return c.json({ ok: true as const });
    })
    .post("/:botId/restart", async (c) => {
      const botId = c.req.param("botId");
      const [bot] = await db.select().from(bots).where(eq(bots.id, botId));
      if (!bot) return c.json({ ok: false as const, error: "Bot not found" }, 404);
      await botPool.restartBot(botId);
      return c.json({ ok: true as const });
    });
}
