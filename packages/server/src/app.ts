import type { Database } from "@cos-tool-bot/database";
import { serveStatic } from "@hono/node-server/serve-static";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { HTTPException } from "hono/http-exception";
import { logger as honoLogger } from "hono/logger";
import {
  ownerOnly,
  ownerOrAdmin,
  requireAppAccess,
  requireRoles,
} from "./middleware/better-auth.js";
import { resolveAllowedOrigins, type AppAuth } from "./auth.js";
import { authzRoutes } from "./routes/authz.js";
import { backupRoutes } from "./routes/backup.js";
import { botsRoutes } from "./routes/bots.js";
import { logRoutes } from "./routes/logs.js";
import { dataTransferRoutes } from "./routes/data-transfer.js";
import { botFilesRoutes } from "./routes/bot-files.js";
import { generationRoutes } from "./routes/generations.js";
import { apiTestRoutes } from "./routes/api-test.js";
import { mcpServerRoutes } from "./routes/mcp-servers.js";
import { createMiniAppBotTokenResolver, miniAppRoutes } from "./routes/mini-app.js";
import { rssRoutes } from "./routes/rss.js";
import { summaryRoutes } from "./routes/summary.js";
import { timerRoutes } from "./routes/timers.js";
import { usageRoutes } from "./routes/usage.js";
import { botRunRoutes } from "./routes/bot-runs.js";
import { botDebugRoutes } from "./routes/bot-debug.js";
import { botGitHubAppRoutes, githubAppCallbackRoutes } from "./routes/github-app.js";
import type { BackupService } from "./services/backup.js";
import type { BotPool } from "./services/bot-pool.js";
import type { ChatSummaryService } from "./services/chat-summary-service.js";
import type { McpClientManager } from "./services/mcp-client-manager.js";
import type { ModelCapabilityService } from "./services/model-capability-service.js";
import type { RssFeedService } from "./services/rss-feed-service.js";
import type { SummaryConfigService } from "./services/summary-config-service.js";
import { BotRunService } from "./services/bot-run-service.js";
import type { TimerRegistry } from "./services/timer-registry.js";
import type { GitHubAppCredentialService } from "./services/github-app-credentials.js";
import type { TelegramMembershipVerifier } from "./services/mini-app-access-policy.js";
import type { MiniAppAccessService } from "./services/mini-app-access-service.js";
import type { TelegramDirectoryService } from "./services/telegram-directory-service.js";

interface AppOptions {
  db: Database;
  auth: AppAuth;
  baseURL: string;
  botPool: BotPool;
  encryptionKey: string;
  backupService: BackupService;
  modelCapabilityService: ModelCapabilityService;
  timerRegistry: TimerRegistry;
  rssFeedService: RssFeedService;
  mcpClientManager: McpClientManager;
  summaryService: ChatSummaryService;
  summaryConfigService: SummaryConfigService;
  githubAppService: GitHubAppCredentialService;
  miniAppSessionSecret: string;
  telegramDirectoryService: TelegramDirectoryService;
  telegramMembershipVerifier: TelegramMembershipVerifier;
  miniAppAccessService: MiniAppAccessService;
}

export function createApp(options: AppOptions) {
  const {
    db,
    auth,
    baseURL,
    botPool,
    encryptionKey,
    backupService,
    modelCapabilityService,
    timerRegistry,
    rssFeedService,
    mcpClientManager,
    summaryService,
    summaryConfigService,
    githubAppService,
    miniAppSessionSecret,
    telegramDirectoryService,
    telegramMembershipVerifier,
    miniAppAccessService,
  } = options;

  const app = new Hono()
    .use("*", honoLogger())
    .use(
      "/api/*",
      cors({
        origin: resolveAllowedOrigins(baseURL),
        credentials: true,
      }),
    )
    .onError((err, c) => {
      if (err instanceof HTTPException) {
        return c.json({ ok: false as const, error: err.message }, err.status);
      }
      console.error("Unhandled error:", err);
      return c.json({ ok: false as const, error: "Internal Server Error" }, 500);
    })
    .on(["GET", "POST"], "/api/auth/*", (c) => auth.handler(c.req.raw))
    .route(
      "/api/mini-app",
      miniAppRoutes({
        sessionSecret: miniAppSessionSecret,
        botTokenResolver: createMiniAppBotTokenResolver(db, encryptionKey),
        directory: telegramDirectoryService,
        membershipVerifier: telegramMembershipVerifier,
        accessService: miniAppAccessService,
      }),
    )
    .route("/api/authz", authzRoutes(auth, db, baseURL))
    .use("/api/bots", requireAppAccess(auth, db))
    .use("/api/bots/*", requireAppAccess(auth, db))
    .use("/api/bots/:botId/runs", requireRoles(ownerOnly))
    .use("/api/bots/:botId/runs/*", requireRoles(ownerOnly))
    .use("/api/bots/:botId/debug", requireRoles(ownerOnly))
    .use("/api/bots/:botId/debug/*", requireRoles(ownerOnly))
    .use("/api/bots/:botId/github-app", requireRoles(ownerOrAdmin))
    .use("/api/bots/:botId/github-app/*", requireRoles(ownerOrAdmin))
    .route("/api/bots", botsRoutes(db, botPool, modelCapabilityService))
    .route("/api/bots", botGitHubAppRoutes(db, githubAppService, botPool))
    .route("/api/bots", dataTransferRoutes(db, encryptionKey))
    .route("/api/bots", botFilesRoutes(db, botPool))
    .route("/api/bots", generationRoutes(db, botPool))
    .route("/api/bots", rssRoutes(rssFeedService))
    .route("/api/bots", summaryRoutes(db, summaryService, summaryConfigService))
    .route("/api/bots", botRunRoutes(new BotRunService(db, encryptionKey)))
    .route("/api/bots", botDebugRoutes(botPool))
    .use("/api/github-app/*", requireAppAccess(auth, db))
    .use("/api/github-app/*", requireRoles(ownerOrAdmin))
    .route("/api/github-app", githubAppCallbackRoutes(db, githubAppService, botPool, baseURL))
    .use("/api/logs", requireAppAccess(auth, db))
    .use("/api/logs/*", requireAppAccess(auth, db))
    .route("/api/logs", logRoutes(db))
    .use("/api/backup", requireAppAccess(auth, db))
    .use("/api/backup/*", requireAppAccess(auth, db))
    .route("/api/backup", backupRoutes(backupService, encryptionKey))
    .use("/api/api-test", requireAppAccess(auth, db))
    .use("/api/api-test/*", requireAppAccess(auth, db))
    .route("/api/api-test", apiTestRoutes())
    .use("/api/timers", requireAppAccess(auth, db))
    .use("/api/timers/*", requireAppAccess(auth, db))
    .route(
      "/api/timers",
      timerRoutes(timerRegistry, (timerId) => botPool.cancelTimer(timerId)),
    )
    .use("/api/usage", requireAppAccess(auth, db))
    .use("/api/usage/*", requireAppAccess(auth, db))
    .route("/api/usage", usageRoutes(db))
    .use("/api/mcp-servers", requireAppAccess(auth, db))
    .use("/api/mcp-servers/*", requireAppAccess(auth, db))
    .route("/api/mcp-servers", mcpServerRoutes(db, mcpClientManager, encryptionKey))
    .get("/api/health", (c) => c.json({ ok: true as const }));

  // Serve panel static files in production (not chained - doesn't affect API types)
  app.use("/*", serveStatic({ root: "./public" }));
  app.get("/*", serveStatic({ root: "./public", path: "index.html" }));

  return app;
}

export type AppType = ReturnType<typeof createApp>;
