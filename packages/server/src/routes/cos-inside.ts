import type { Database } from "@cos-tool-bot/database";
import { bots } from "@cos-tool-bot/database";
import { eq } from "drizzle-orm";
import { Hono } from "hono";
import type { AuthVariables } from "../middleware/better-auth.js";
import {
  normalizeTelegramChatSubjectQuery,
  searchTelegramChatSubjects,
} from "../services/telegram-chat-subjects.js";

export function cosInsideRoutes(db: Database) {
  return new Hono<{ Variables: AuthVariables }>().get("/:botId/cos-inside/groups", async (c) => {
    const botId = c.req.param("botId");
    const query = normalizeTelegramChatSubjectQuery(c.req.query("query"));
    if (query.length > 64) {
      return c.json({ ok: false as const, error: "invalid_subject_search" }, 400);
    }

    const [bot] = await db.select({ id: bots.id }).from(bots).where(eq(bots.id, botId)).limit(1);
    if (!bot) return c.json({ ok: false as const, error: "Bot not found" }, 404);

    return c.json({
      ok: true as const,
      subjects: await searchTelegramChatSubjects(db, botId, query),
    });
  });
}
