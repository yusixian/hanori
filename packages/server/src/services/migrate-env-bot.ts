import type { Database } from "@cos-tool-bot/database";
import { bots } from "@cos-tool-bot/database";
import { count } from "drizzle-orm";
import type { Logger } from "pino";
import { env } from "../env.js";
import { encrypt } from "../utils/crypto.js";

export async function migrateEnvBot(db: Database, logger: Logger) {
  if (!env.BOT_TOKEN) return;

  try {
    const rows = await db.select({ total: count() }).from(bots);
    if ((rows[0]?.total ?? 0) > 0) return;

    const encryptedToken = encrypt(env.BOT_TOKEN, env.ENCRYPTION_KEY);
    await db.insert(bots).values({
      name: "Default Bot",
      encryptedToken,
      adminChatIds: env.ADMIN_CHAT_IDS,
      isActive: true,
    });

    logger.info("Migrated BOT_TOKEN from environment variable to bots table");
  } catch (err) {
    logger.warn(err, "Failed to migrate BOT_TOKEN (bots table may not exist yet — run migrations)");
  }
}
