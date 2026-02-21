import { createDb } from "@cos-tool-bot/database";
import { serve } from "@hono/node-server";
import pino from "pino";
import { createApp } from "./app.js";
import { env } from "./env.js";
import { BotManager } from "./services/bot-manager.js";

const logger = pino({
  transport: {
    target: "pino-pretty",
    options: { colorize: true },
  },
});

// Database
const db = createDb(env.DATABASE_URL);
logger.info("Database connected");

// Bot Manager
const botManager = new BotManager({
  token: env.BOT_TOKEN,
  adminChatIds: env.ADMIN_CHAT_IDS,
  logger,
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
    logger.info(`Server running on http://localhost:${info.port}`);
  },
);

// Graceful shutdown
const shutdown = async (signal: string) => {
  logger.info(`[${signal}] Shutting down...`);
  await botManager.stop();
  process.exit(0);
};

process.once("SIGINT", () => shutdown("SIGINT"));
process.once("SIGTERM", () => shutdown("SIGTERM"));
