import type { Database } from "@cos-tool-bot/database";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { logger as honoLogger } from "hono/logger";
import { serveStatic } from "@hono/node-server/serve-static";
import { jwtAuth } from "./middleware/auth.js";
import { authRoutes } from "./routes/auth.js";
import { botRoutes } from "./routes/bot.js";
import { logRoutes } from "./routes/logs.js";
import type { BotManager } from "./services/bot-manager.js";

interface AppOptions {
  db: Database;
  botManager: BotManager;
  panelPassword: string;
  jwtSecret: string;
}

export function createApp(options: AppOptions) {
  const { db, botManager, panelPassword, jwtSecret } = options;

  const app = new Hono()
    .use("*", honoLogger())
    .use("/api/*", cors())
    .route("/api/auth", authRoutes(panelPassword, jwtSecret))
    .use("/api/bot/*", jwtAuth(jwtSecret))
    .route("/api/bot", botRoutes(botManager))
    .use("/api/logs/*", jwtAuth(jwtSecret))
    .route("/api/logs", logRoutes(db))
    .get("/api/health", (c) => c.json({ ok: true as const }));

  // Serve panel static files in production (not chained - doesn't affect API types)
  app.use("/*", serveStatic({ root: "./public" }));
  app.get("/*", serveStatic({ root: "./public", path: "index.html" }));

  return app;
}

export type AppType = ReturnType<typeof createApp>;
