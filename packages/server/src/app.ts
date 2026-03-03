import type { Database } from "@cos-tool-bot/database";
import { serveStatic } from "@hono/node-server/serve-static";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { HTTPException } from "hono/http-exception";
import { logger as honoLogger } from "hono/logger";
import { jwtAuth } from "./middleware/auth.js";
import { authRoutes } from "./routes/auth.js";
import { backupRoutes } from "./routes/backup.js";
import { botsRoutes } from "./routes/bots.js";
import { logRoutes } from "./routes/logs.js";
import { dataTransferRoutes } from "./routes/data-transfer.js";
import { botFilesRoutes } from "./routes/bot-files.js";
import { generationRoutes } from "./routes/generations.js";
import { apiTestRoutes } from "./routes/api-test.js";
import { usageRoutes } from "./routes/usage.js";
import type { BackupService } from "./services/backup.js";
import type { BotPool } from "./services/bot-pool.js";
import type { ModelCapabilityService } from "./services/model-capability-service.js";

interface AppOptions {
  db: Database;
  botPool: BotPool;
  panelPassword: string;
  jwtSecret: string;
  encryptionKey: string;
  backupService: BackupService;
  modelCapabilityService: ModelCapabilityService;
}

export function createApp(options: AppOptions) {
  const {
    db,
    botPool,
    panelPassword,
    jwtSecret,
    encryptionKey,
    backupService,
    modelCapabilityService,
  } = options;

  const app = new Hono()
    .use("*", honoLogger())
    .use("/api/*", cors())
    .onError((err, c) => {
      if (err instanceof HTTPException) {
        return c.json({ ok: false as const, error: err.message }, err.status);
      }
      console.error("Unhandled error:", err);
      return c.json({ ok: false as const, error: "Internal Server Error" }, 500);
    })
    .route("/api/auth", authRoutes(panelPassword, jwtSecret))
    .use("/api/bots/*", jwtAuth(jwtSecret))
    .route("/api/bots", botsRoutes(db, botPool, modelCapabilityService))
    .route("/api/bots", dataTransferRoutes(db, encryptionKey))
    .route("/api/bots", botFilesRoutes(db, botPool))
    .route("/api/bots", generationRoutes(db))
    .use("/api/logs/*", jwtAuth(jwtSecret))
    .route("/api/logs", logRoutes(db))
    .use("/api/backup/*", jwtAuth(jwtSecret))
    .route("/api/backup", backupRoutes(backupService, encryptionKey))
    .use("/api/api-test/*", jwtAuth(jwtSecret))
    .route("/api/api-test", apiTestRoutes())
    .use("/api/usage/*", jwtAuth(jwtSecret))
    .route("/api/usage", usageRoutes(db))
    .get("/api/health", (c) => c.json({ ok: true as const }));

  // Serve panel static files in production (not chained - doesn't affect API types)
  app.use("/*", serveStatic({ root: "./public" }));
  app.get("/*", serveStatic({ root: "./public", path: "index.html" }));

  return app;
}

export type AppType = ReturnType<typeof createApp>;
