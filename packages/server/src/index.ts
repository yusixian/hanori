import { createDb, runMigrations } from "@cos-tool-bot/database";
import { bots } from "@cos-tool-bot/database";
import { serve } from "@hono/node-server";
import { eq } from "drizzle-orm";
import pino from "pino";
import { createApp } from "./app.js";
import { createAuth, ensureAuthBootstrap } from "./auth.js";
import { env } from "./env.js";
import { BackupService } from "./services/backup.js";
import { BotPool } from "./services/bot-pool.js";
import { ChatSummaryService } from "./services/chat-summary-service.js";
import { ModelCapabilityService } from "./services/model-capability-service.js";
import { DbLogger } from "./services/db-logger.js";
import { GenerationCleaner } from "./services/generation-cleaner.js";
import { LogCleaner } from "./services/log-cleaner.js";
import { BotRunCleaner } from "./services/bot-run-cleaner.js";
import { MemoryGC } from "./services/memory-gc.js";
import { McpClientManager } from "./services/mcp-client-manager.js";
import { CodingWorkerClient } from "./services/coding-worker-client.js";
import { CodingJobStager } from "./services/coding-job-stager.js";
import { GitWorkspaceService } from "./services/git-workspace-service.js";
import { RssFeedService } from "./services/rss-feed-service.js";
import { SummaryConfigService } from "./services/summary-config-service.js";
import { SummaryRunner } from "./services/summary-runner.js";
import { TimerRegistry } from "./services/timer-registry.js";
import { migrateAiConfig } from "./utils/ai-config-migrate.js";
import { migrateEnvBot } from "./services/migrate-env-bot.js";

export type { AppType } from "./app.js";

const logger = pino({
  transport: {
    target: "pino-pretty",
    options: { colorize: true },
  },
});

// Uncaught exception / unhandled rejection — log and exit, let Docker restart
process.on("uncaughtException", (err) => {
  logger.fatal(err, "Uncaught exception — exiting");
  process.exit(1);
});
process.on("unhandledRejection", (reason) => {
  logger.fatal({ reason }, "Unhandled rejection — exiting");
  process.exit(1);
});

// Warn about default encryption key
if (env.USING_DEFAULT_ENCRYPTION_KEY) {
  logger.warn(
    "⚠ ENCRYPTION_KEY is not set — using built-in default. Set ENCRYPTION_KEY in .env for production!",
  );
}

// Database
await runMigrations(env.DATABASE_URL);
logger.info("Database migrated");
const { db, client: dbClient } = createDb(env.DATABASE_URL);
logger.info("Database connected");

// Better Auth owns all browser sessions and the initial workspace owner.
const auth = createAuth(db, {
  baseURL: env.BETTER_AUTH_URL,
  secret: env.BETTER_AUTH_SECRET,
  ownerEmail: env.AUTH_OWNER_EMAIL,
  googleClientId: env.GOOGLE_CLIENT_ID,
  googleClientSecret: env.GOOGLE_CLIENT_SECRET,
});
await ensureAuthBootstrap(auth, env.AUTH_OWNER_EMAIL, env.PANEL_PASSWORD);
logger.info("Authentication initialized");

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

// Structured debugger records: successful runs expire after 7 days, failures after 30.
// Pinned records are excluded by the cleaner.
const botRunCleaner = new BotRunCleaner(db, logger);
botRunCleaner.start();

// Memory GC
const memoryGC = new MemoryGC({
  db,
  logger,
  inactiveRetentionDays: 30,
  intervalHours: 24,
});
memoryGC.start();

// Generation Cleaner
const generationCleaner = new GenerationCleaner({
  db,
  logger,
  retentionDays: env.GENERATION_RETENTION_DAYS,
  intervalHours: 24,
});
generationCleaner.start();

// Migrate BOT_TOKEN from env to bots table (one-time)
await migrateEnvBot(db, logger);

// Backup Service
const backupService = new BackupService({
  db,
  databaseUrl: env.DATABASE_URL,
  backupDir: env.BACKUP_DIR,
  encryptionKey: env.ENCRYPTION_KEY,
  logger,
});
await backupService.init();

// Model Capability Service
const modelCapabilityService = new ModelCapabilityService(logger);
await modelCapabilityService.init();

// Timer Registry
const timerRegistry = new TimerRegistry(db, logger);

// RSS Feed Service
const rssFeedService = new RssFeedService(db, logger);

// MCP Client Manager
const mcpClientManager = new McpClientManager(db, logger, env.ENCRYPTION_KEY);

// Bot Pool
const botPool = new BotPool(db, logger, timerRegistry);
const codingWorkerClient = new CodingWorkerClient({
  url: env.CODING_WORKER_URL,
  socketPath: env.CODING_WORKER_SOCKET,
  secret: env.CODING_WORKER_SECRET,
});
if (codingWorkerClient.configured) {
  botPool.setGitWorkspaceService(
    new GitWorkspaceService(
      env.CODING_WORKSPACES_DIR,
      env.CODING_GIT_DIR,
      codingWorkerClient,
      env.CODING_WORKSPACE_UID,
      env.CODING_WORKSPACE_GID,
      undefined,
      new CodingJobStager(
        env.CODING_JOB_DIR,
        {},
        {
          uid: env.CODING_WORKSPACE_UID,
          gid: env.CODING_WORKSPACE_GID,
        },
      ),
    ),
  );
} else {
  logger.warn(
    "Pi coding worker is not configured; GitHub code, push, and recovery tools are disabled",
  );
}
botPool.setBackupService(backupService);
botPool.setRssFeedService(rssFeedService);
botPool.setMcpClientManager(mcpClientManager);

// Summary Services
const summaryConfigService = new SummaryConfigService(db);

const summaryRunner = new SummaryRunner(db, logger, env.ENCRYPTION_KEY, async (botId) => {
  const [row] = await db
    .select({ aiConfig: bots.aiConfig, isActive: bots.isActive })
    .from(bots)
    .where(eq(bots.id, botId));
  if (!row?.isActive) return null;
  const cfg = row.aiConfig;
  if (!cfg) return null;
  return migrateAiConfig(cfg);
});

const summaryService = new ChatSummaryService(
  db,
  logger,
  summaryRunner,
  (botId, chatId, html) => botPool.sendHtml(botId, chatId, html),
  (botId) => botPool.getManager(botId)?.status === "running",
  async (botId) => {
    const [row] = await db.select({ aiConfig: bots.aiConfig }).from(bots).where(eq(bots.id, botId));
    const sc = row?.aiConfig?.summaryConfig;
    if (!sc) return null;
    return {
      enabled: sc.enabled,
      globalScheduleHour: sc.globalScheduleHour,
      globalScheduleMinute: sc.globalScheduleMinute,
      timezone: sc.timezone,
    };
  },
);

botPool.setSummaryService(summaryService);
botPool.setSummaryConfigService(summaryConfigService);

// Hono App
const app = createApp({
  db,
  auth,
  baseURL: env.BETTER_AUTH_URL,
  botPool,
  encryptionKey: env.ENCRYPTION_KEY,
  backupService,
  modelCapabilityService,
  timerRegistry,
  rssFeedService,
  mcpClientManager,
  summaryService,
  summaryConfigService,
});

// Start HTTP server (before bots so the panel is immediately reachable)
serve(
  {
    fetch: app.fetch,
    port: env.PORT,
  },
  (info) => {
    dbLogger.info(`Server running on http://localhost:${info.port}`).catch(() => {});
  },
);

// Connect MCP servers before bots so tools are available at bot startup
await mcpClientManager.connectAll();

// Start all active bots
await botPool.startAll();

// Start RSS feed service (after bots so digest triggers have handlers)
rssFeedService.start();

// Start summary service (after bots so sendHtml has running managers)
summaryService.start();

// Register system timers
const scheduledServices: [
  string,
  { getHandle(): ReturnType<typeof setInterval> | null; getIntervalMs(): number },
][] = [
  ["LogCleaner", logCleaner],
  ["MemoryGC", memoryGC],
  ["GenerationCleaner", generationCleaner],
  ["ModelCapabilityService", modelCapabilityService],
];
for (const [name, svc] of scheduledServices) {
  const handle = svc.getHandle();
  if (handle) {
    timerRegistry.registerSystem({ name, intervalMs: svc.getIntervalMs(), handle });
  }
}

// Recover AI timers from database
await timerRegistry.recoverAiTimers(
  (timerId, botId, chatId, meta) => {
    botPool.fireRecoveredTimer(timerId, botId, chatId, meta);
  },
  (botId) => botPool.getManager(botId)?.status === "running",
);

// Graceful shutdown
const shutdown = async (signal: string) => {
  await dbLogger.info(`[${signal}] Shutting down...`);
  await mcpClientManager.destroyAll();
  rssFeedService.stop();
  summaryService.stop();
  timerRegistry.destroy();
  modelCapabilityService.stop();
  logCleaner.stop();
  memoryGC.stop();
  generationCleaner.stop();
  await botPool.stopAll();
  await dbClient.end();
  process.exit(0);
};

process.once("SIGINT", () => shutdown("SIGINT"));
process.once("SIGTERM", () => shutdown("SIGTERM"));
