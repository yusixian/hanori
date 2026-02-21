import { createDb } from "@cos-tool-bot/database";
import { serve } from "@hono/node-server";
import pino from "pino";
import { createApp } from "./app.js";
import { env } from "./env.js";
import { BotPool } from "./services/bot-pool.js";
import { DbLogger } from "./services/db-logger.js";
import { LogCleaner } from "./services/log-cleaner.js";
import { migrateEnvBot } from "./services/migrate-env-bot.js";

export type { AppType } from "./app.js";

const logger = pino({
  transport: {
    target: "pino-pretty",
    options: { colorize: true },
  },
});

// Warn about default encryption key
if (env.USING_DEFAULT_ENCRYPTION_KEY) {
  logger.warn(
    "⚠ ENCRYPTION_KEY is not set — using built-in default. Set ENCRYPTION_KEY in .env for production!",
  );
}

// Database
const db = createDb(env.DATABASE_URL);
logger.info("Database connected");

// Database Logger (system-level, no botId)
const dbLogger = new DbLogger(db, logger);

// Log Cleaner
const logCleaner = new LogCleaner({
  db,
  logger,
  retentionDays: env.LOG_RETENTION_DAYS,
  retentionDaysError: env.LOG_RETENTION_DAYS_ERROR,
  intervalHours: env.LOG_CLEANUP_INTERVAL_HOURS,
});
logCleaner.start();

// Migrate BOT_TOKEN from env to bots table (one-time)
await migrateEnvBot(db, logger);

// Bot Pool
const botPool = new BotPool(db, logger);

// Hono App
const app = createApp({
  db,
  botPool,
  panelPassword: env.PANEL_PASSWORD,
  jwtSecret: env.JWT_SECRET,
});

// Start all active bots
await botPool.startAll();

// Start HTTP server
serve(
  {
    fetch: app.fetch,
    port: env.PORT,
  },
  (info) => {
    dbLogger.info(`Server running on http://localhost:${info.port}`).catch(() => {});
  },
);

// Graceful shutdown
const shutdown = async (signal: string) => {
  await dbLogger.info(`[${signal}] Shutting down...`);
  logCleaner.stop();
  await botPool.stopAll();
  process.exit(0);
};

process.once("SIGINT", () => shutdown("SIGINT"));
process.once("SIGTERM", () => shutdown("SIGTERM"));
