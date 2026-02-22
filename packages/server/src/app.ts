import type { Database } from "@cos-tool-bot/database";
import { serveStatic } from "@hono/node-server/serve-static";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { logger as honoLogger } from "hono/logger";
import { jwtAuth } from "./middleware/auth.js";
import { authRoutes } from "./routes/auth.js";
import { botsRoutes } from "./routes/bots.js";
import { logRoutes } from "./routes/logs.js";
import { dataTransferRoutes } from "./routes/data-transfer.js";
import type { BotPool } from "./services/bot-pool.js";

interface AppOptions {
  db: Database;
  botPool: BotPool;
  panelPassword: string;
  jwtSecret: string;
  encryptionKey: string;
}

export function createApp(options: AppOptions) {
  const { db, botPool, panelPassword, jwtSecret, encryptionKey } = options;

  const app = new Hono()
    .use("*", honoLogger())
    .use("/api/*", cors())
    .route("/api/auth", authRoutes(panelPassword, jwtSecret))
    .use("/api/bots/*", jwtAuth(jwtSecret))
    .route("/api/bots", botsRoutes(db, botPool))
    .route("/api/bots", dataTransferRoutes(db, encryptionKey))
    .use("/api/logs/*", jwtAuth(jwtSecret))
    .route("/api/logs", logRoutes(db))
    .get("/api/health", (c) => c.json({ ok: true as const }));

  // Serve panel static files in production (not chained - doesn't affect API types)
  app.use("/*", serveStatic({ root: "./public" }));
  app.get("/*", serveStatic({ root: "./public", path: "index.html" }));

  return app;
}

export type AppType = ReturnType<typeof createApp>;
