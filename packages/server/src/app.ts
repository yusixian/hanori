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

  const app = new Hono();

  app.use("*", honoLogger());
  app.use("/api/*", cors());

  // Public routes
  app.route("/api/auth", authRoutes(panelPassword, jwtSecret));

  // Protected routes
  const protectedApi = new Hono();
  protectedApi.use("*", jwtAuth(jwtSecret));
  protectedApi.route("/bot", botRoutes(botManager));
  protectedApi.route("/logs", logRoutes(db));
  app.route("/api", protectedApi);

  // Health check
  app.get("/api/health", (c) => c.json({ ok: true }));

  // Serve panel static files in production
  app.use("/*", serveStatic({ root: "./public" }));
  app.get("/*", serveStatic({ root: "./public", path: "index.html" }));

  return app;
}
