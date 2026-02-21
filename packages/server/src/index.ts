import { createDb } from "@cos-tool-bot/database";
import { serve } from "@hono/node-server";
import pino from "pino";
import { createApp } from "./app.js";
import { env } from "./env.js";
import { BotManager } from "./services/bot-manager.js";
import { DbLogger } from "./services/db-logger.js";
import { LogCleaner } from "./services/log-cleaner.js";

export type { AppType } from "./app.js";

const logger = pino({
  transport: {
    target: "pino-pretty",
    options: { colorize: true },
  },
});

// Database
const db = createDb(env.DATABASE_URL);
logger.info("Database connected");

// Database Logger
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

// Bot Manager
const botManager = new BotManager({
  token: env.BOT_TOKEN,
  adminChatIds: env.ADMIN_CHAT_IDS,
  logger,
  dbLogger,
});

// Hono App
const app = createApp({
  db,
  botManager,
  panelPassword: env.PANEL_PASSWORD,
  jwtSecret: env.JWT_SECRET,
});

// Start bot
await botManager.start();

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
  await botManager.stop();
  process.exit(0);
};

process.once("SIGINT", () => shutdown("SIGINT"));
process.once("SIGTERM", () => shutdown("SIGTERM"));
