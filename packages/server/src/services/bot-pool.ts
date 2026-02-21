import type { Database } from "@cos-tool-bot/database";
import { bots } from "@cos-tool-bot/database";
import { eq } from "drizzle-orm";
import type { Logger } from "pino";
import { env } from "../env.js";
import { decrypt } from "../utils/crypto.js";
import { BotManager } from "./bot-manager.js";
import { DbLogger } from "./db-logger.js";

export class BotPool {
  private managers = new Map<string, BotManager>();

  constructor(
    private db: Database,
    private logger: Logger,
  ) {}

  async startAll() {
    let activeBots;
    try {
      activeBots = await this.db.select().from(bots).where(eq(bots.isActive, true));
    } catch (err) {
      this.logger.warn(err, "Failed to query active bots (table may not exist — run migrations)");
      return;
    }
    this.logger.info(`Starting ${activeBots.length} active bot(s)...`);
    for (const bot of activeBots) {
      try {
        await this.startBot(bot.id);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        this.logger.error(err, `Failed to start bot "${bot.name}" (${bot.id}): ${msg}`);
      }
    }
  }

  async stopAll() {
    const ids = [...this.managers.keys()];
    for (const id of ids) {
      try {
        await this.stopBot(id);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        this.logger.error(err, `Failed to stop bot ${id}: ${msg}`);
      }
    }
  }

  async startBot(botId: string) {
    if (this.managers.has(botId)) {
      this.logger.warn(`Bot ${botId} is already managed, skipping`);
      return;
    }

    const [bot] = await this.db.select().from(bots).where(eq(bots.id, botId));
    if (!bot) throw new Error(`Bot ${botId} not found`);

    const token = decrypt(bot.encryptedToken, env.ENCRYPTION_KEY);
    const dbLogger = new DbLogger(this.db, this.logger, botId);
    const manager = new BotManager({
      botId,
      token,
      adminChatIds: bot.adminChatIds,
      logger: this.logger,
      dbLogger,
    });

    this.managers.set(botId, manager);
    await manager.start();
  }

  async stopBot(botId: string) {
    const manager = this.managers.get(botId);
    if (!manager) return;
    await manager.stop();
    this.managers.delete(botId);
  }

  async restartBot(botId: string) {
    await this.stopBot(botId);
    await this.startBot(botId);
  }

  getManager(botId: string): BotManager | undefined {
    return this.managers.get(botId);
  }

  getAllManagers(): Map<string, BotManager> {
    return this.managers;
  }
}
