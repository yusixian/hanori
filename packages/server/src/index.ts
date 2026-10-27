import { registerFatalErrorHandlers } from "./fatal-errors.js";
import { UsageMaintenanceService } from "./services/usage-maintenance.js";
import { redactDiagnostic } from "./services/run-redaction.js";
import { createShutdownHandler, ShutdownSteps } from "./utils/shutdown.js";
import { PluginManager } from "./services/plugins/manager.js";
import { GitPluginArtifacts } from "./services/plugins/git-artifacts.js";
import { createBuiltinMediaPlugins } from "./services/plugins/builtin-media.js";
import type { MediaTranscriptionPort } from "@cos-tool-bot/shared";
import { MediaJobService } from "./services/media-jobs/service.js";
import { formatMediaJobNotice } from "./services/media-jobs/notification.js";
import { MediaJobExecutor, requireStoppedWorker } from "./services/media-jobs/executor.js";
import { loadMediaJobConfiguration } from "./services/media-jobs/configuration.js";
import { AsrSettingsService } from "./services/asr-settings.js";
import { MediaAudioStore } from "./services/media/audio-store.js";
import { IsolatedAudioConverter } from "./services/media/isolated-converter.js";
import { createDb, runMigrations } from "@cos-tool-bot/database";
import { NsfwChecker } from "@cos-tool-bot/bot";
import { bots } from "@cos-tool-bot/database";
import path from "node:path";
import { getDataDir } from "@cos-tool-bot/shared/file-validation";
import { serve } from "@hono/node-server";
import { eq } from "drizzle-orm";
import pino from "pino";
import { createApp } from "./app.js";
import { createAuth, ensureAuthBootstrap } from "./auth.js";
import { env } from "./env.js";
import { BackupService } from "./services/backup.js";
import { BotPool } from "./services/bot-pool.js";
import { ChatIdentityMigrationService } from "./services/chat-identity-migration-service.js";
import { ChatSummaryService } from "./services/chat-summary-service.js";
import { ModelCapabilityService } from "./services/model-capability-service.js";
import { DbLogger } from "./services/db-logger.js";
import { GenerationCleaner } from "./services/generation-cleaner.js";
import { LogCleaner } from "./services/log-cleaner.js";
import { BotRunCleaner } from "./services/bot-run-cleaner.js";
import { MemoryGC } from "./services/memory-gc.js";
import { MemoryConsolidator } from "./services/memory-consolidator.js";
import { McpClientManager } from "./services/mcp-client-manager.js";
import { VideoDownloadService } from "./services/video-downloads/service.js";
import { VideoDownloadExecutor } from "./services/video-downloads/executor.js";
import { VideoDownloadCache } from "./services/video-downloads/cache.js";
import { loadVideoDownloadConfiguration } from "./services/video-downloads/configuration.js";
import type { VideoDownloadPort } from "@cos-tool-bot/shared";
import { CodingWorkerClient } from "./services/coding-worker-client.js";
import { CodingJobStager } from "./services/coding-job-stager.js";
import { GitWorkspaceService } from "./services/git-workspace-service.js";
import { GitHubAppCredentialService } from "./services/github-app-credentials.js";
import { HarnessAdmin } from "./harness/admin.js";
import { GitHubAppHarnessClient } from "./harness/github.js";
import { HarnessService } from "./harness/service.js";
import { DrizzleHarnessStore } from "./harness/store.js";
import { createPrSummarizer } from "./harness/summary.js";
import { toAiConfigRuntime } from "./services/ai-config-runtime.js";
import { RssFeedService } from "./services/rss-feed-service.js";
import { SummaryConfigService } from "./services/summary-config-service.js";
import { SummaryRunner } from "./services/summary-runner.js";
import { TimerRegistry } from "./services/timer-registry.js";
import { migrateAiConfig } from "./utils/ai-config-migrate.js";
import { migrateEnvBot } from "./services/migrate-env-bot.js";
import { BotPoolTelegramRuntimeAdapter } from "./services/telegram-bot-runtime.js";
import { TelegramDirectoryService } from "./services/telegram-directory-service.js";
import { MiniAppAccessService } from "./services/mini-app-access-service.js";
import { GroupConfigService } from "./services/group-config-service.js";
import { ChatAiSelectionService } from "./services/chat-ai-selection-service.js";
import { BotLifecycleService } from "./services/bot-lifecycle-service.js";
import { BotSettingsService } from "./services/bot-settings-service.js";
import { UsageGovernor } from "./services/usage-governor.js";
import { ImageMcpConnectionService } from "./services/image-mcp-connection-service.js";
import { ImageMcpPlatformService } from "./services/image-mcp-platform.js";
import { ImageGenerationService } from "./services/image-generation-service.js";
import { BotConfiguredGeneralImageBackend } from "./services/general-image-backend.js";
import { ChatAiSelectionRuntimeRegistry } from "./services/chat-ai-selection-runtime-registry.js";
import { resolveDeploymentVersion, RuntimeHealth } from "./runtime-health.js";
import {
  EngagementSampleCleaner,
  EngagementSampleService,
} from "./services/engagement-sample-service.js";

export type { AppType } from "./app.js";

const logger = pino({
  transport: {
    target: "pino-pretty",
    options: { colorize: true },
  },
});
const runtimeHealth = new RuntimeHealth(
  resolveDeploymentVersion({ environmentValue: env.APP_VERSION }),
);

registerFatalErrorHandlers(logger);

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
const mediaConverter = env.MEDIA_WORKER_SECRET
  ? new IsolatedAudioConverter(env.MEDIA_WORKER_SOCKET, env.MEDIA_WORKER_SECRET)
  : undefined;
const asrSettings = new AsrSettingsService(db, env.ENCRYPTION_KEY);
const asrAudioStore = new MediaAudioStore(
  env.MEDIA_JOB_DIR,
  env.BETTER_AUTH_URL,
  env.ENCRYPTION_KEY,
);
let mediaJobService: MediaJobService;
let videoDownloadService: VideoDownloadService;
const videoDownloads: VideoDownloadPort | undefined = mediaConverter
  ? {
      create: (actor, input, signal) => videoDownloadService.create(actor, input, signal),
      get: (actor, id) => videoDownloadService.get(actor, id),
      cancel: (actor, id) => videoDownloadService.cancel(actor, id),
    }
  : undefined;
// Built-ins bind this port lazily; sessions only open after all services are composed.
const mediaTranscription: MediaTranscriptionPort | undefined = mediaConverter
  ? {
      create: (actor, input, signal) => mediaJobService!.create(actor, input, signal),
      confirm: (actor, id) => mediaJobService!.confirm(actor, id),
      get: (actor, id) => mediaJobService!.get(actor, id),
      cancel: (actor, id) => mediaJobService!.cancel(actor, id),
      read: (actor, id) => mediaJobService!.read(actor, id),
    }
  : undefined;
const pluginManager = new PluginManager(
  db,
  env.ENCRYPTION_KEY,
  new GitPluginArtifacts(path.resolve(env.PLUGIN_DIRECTORY)),
  createBuiltinMediaPlugins({ transcription: mediaTranscription, downloads: videoDownloads }),
  (failure) => logger.warn(failure, "Plugin login failed"),
);

// Bot Pool
const botPool = new BotPool(db, logger, timerRegistry);
const nsfwChecker = env.NSFW_API_URL
  ? new NsfwChecker({
      apiUrl: env.NSFW_API_URL,
      logger: (level, message, meta) => logger[level](meta ?? {}, message),
    })
  : undefined;
if (nsfwChecker) botPool.setNsfwChecker(nsfwChecker);
{
  const executor = new VideoDownloadExecutor(
    new VideoDownloadCache({
      root: path.resolve(env.MEDIA_JOB_DIR, "video-downloads"),
      beforeRemove: (id) =>
        mediaConverter ? mediaConverter.cancel(id) : requireStoppedWorker(env.MEDIA_WORKER_SOCKET),
    }),
    mediaConverter,
    env.MEDIA_WORKER_GID,
    env.MEDIA_WORKER_SOCKET,
  );
  videoDownloadService = new VideoDownloadService(db, {
    configuration: (botId) =>
      mediaConverter ? loadVideoDownloadConfiguration(pluginManager, botId) : Promise.resolve(null),
    inspect: (source, config, signal) => executor.inspect(source, config, signal),
    download: (row, config, options) => executor.download(row, config, options),
    cleanup: (id, retain) => executor.cleanup(id, retain),
    sweep: () => executor.sweep(),
    deliver: (row, file, signal) =>
      botPool.sendVideoFile(row.botId, row.chatId, file.path, {
        title: row.title,
        durationSeconds: row.durationSeconds,
        ...(row.threadId === null ? {} : { threadId: row.threadId }),
        signal,
      }),
    notifyFailure: (row) =>
      botPool.sendHtml(
        row.botId,
        row.chatId,
        `视频下载 / Video download: <code>${row.id}</code>\n${row.status === "delivery_unknown" ? "发送结果待确认，请先检查聊天记录，未自动重发。 / Delivery uncertain; check the chat before requesting again." : row.status === "cancelled" ? "已取消 / Cancelled" : "未完成 / Failed"}\n${row.error ?? "download_failed"}`,
        row.threadId ?? undefined,
        AbortSignal.timeout(15_000),
      ),
    reportError: (code) => logger.warn({ code }, "Video download maintenance failed"),
  });
  pluginManager.onConfigurationChanged(async (pluginId, botId) => {
    if (pluginId === "hanori.bilibili") await videoDownloadService.cancelForBot(botId);
  });
}
const mediaConfiguration = (botId: string) =>
  mediaConverter
    ? loadMediaJobConfiguration(pluginManager, botId, asrSettings)
    : Promise.resolve(null);
{
  // Retention and abandoned-job cleanup continue after the media profile is disabled.
  const executor = new MediaJobExecutor(
    env.MEDIA_JOB_DIR,
    mediaConverter,
    env.MEDIA_WORKER_GID,
    env.MEDIA_WORKER_SOCKET,
    asrAudioStore,
  );
  mediaJobService = new MediaJobService(db, {
    configuration: (botId, account) =>
      mediaConverter
        ? loadMediaJobConfiguration(
            pluginManager,
            botId,
            asrSettings,
            account as "tencent" | "aliyun" | "groq" | "openai" | "legacy" | undefined,
          )
        : Promise.resolve(null),
    configurations: async (botId) => {
      if (!mediaConverter) return [];
      const candidates = await Promise.all(
        (["tencent", "aliyun", "groq", "openai"] as const).map((provider) =>
          loadMediaJobConfiguration(pluginManager, botId, asrSettings, provider),
        ),
      );
      return candidates.filter((config) => config !== null);
    },
    authorize: (actor) => botPool.isMediaAdmin(actor.botId, actor.userId),
    requestConfirmation: (job, actor) =>
      botPool.sendMediaConfirmation(actor.botId, actor.chatId, job, actor.threadId),
    inspect: (source, config, signal) => executor.inspect(source, config, signal),
    execute: (job, config, options) => executor.execute(job, config, options),
    resume: (job, config, signal) => executor.resume(job, config, signal),
    cleanup: (id, attempt) => executor.cleanup(id, attempt),
    cleanupCompleted: (id) => asrAudioStore.remove(id),
    sweep: () => asrAudioStore.sweep(),
    notify: (job) =>
      botPool.sendHtml(job.botId, job.chatId, formatMediaJobNotice(job), job.threadId ?? undefined),
  });
  pluginManager.onConfigurationChanged(async (pluginId, botId) => {
    if (pluginId === "hanori.bilibili") await mediaJobService!.cancelForBot(botId);
  });
}
if (mediaTranscription) botPool.setMediaTranscriptionPort(mediaTranscription);
const engagementSampleService = new EngagementSampleService(db);
const engagementSampleCleaner = new EngagementSampleCleaner(engagementSampleService, logger);
engagementSampleCleaner.start();
botPool.setEngagementSampleService(engagementSampleService);
const usageGovernor = new UsageGovernor(db);
const imageMcpPlatform = new ImageMcpPlatformService(
  db,
  (provider, endpointOverride) => {
    const name =
      provider === "mcp_pixai"
        ? "pixai"
        : provider === "mcp_openai"
          ? "openai-image"
          : "gemini-image";
    return new ImageMcpConnectionService({
      db,
      encryptionKey: env.ENCRYPTION_KEY,
      baseURL: env.BETTER_AUTH_URL,
      logger,
      environment: process.env.NODE_ENV === "production" ? "production" : "non-production",
      endpointOverride,
      connectionId: provider === "mcp_pixai" ? "default" : name,
      routePrefix:
        provider === "mcp_pixai"
          ? "/api/image-mcp"
          : provider === "mcp_openai"
            ? "/api/image-mcp-openai"
            : "/api/image-mcp-gemini",
      scopes: [
        "openid",
        "profile",
        "offline_access",
        `mcp:${name}:read`,
        `mcp:${name}:generate`,
        `mcp:${name}:cancel`,
      ],
    });
  },
  {
    mcp_pixai: env.PIXAI_MCP_URL,
    mcp_openai: env.OPENAI_IMAGE_MCP_URL,
    mcp_gemini: env.GEMINI_IMAGE_MCP_URL,
  },
);
await imageMcpPlatform.initialize();
const imageMcpConnectionService = imageMcpPlatform.connection("mcp_pixai")!;
const imageMcpConnections = {
  mcp_openai: imageMcpPlatform.connection("mcp_openai")!,
  mcp_gemini: imageMcpPlatform.connection("mcp_gemini")!,
};
const imageGenerationService = new ImageGenerationService({
  db,
  nsfwChecker,
  generationLibrary: botPool.getGenerationLibraryService(),
  usageGovernor,
  pixai: imageMcpConnectionService.adapter,
  artifacts: imageMcpConnectionService.artifacts,
  backends: {
    get mcp_pixai() {
      return imageMcpPlatform.backend("mcp_pixai");
    },
    get mcp_openai() {
      return imageMcpPlatform.backend("mcp_openai");
    },
    get mcp_gemini() {
      return imageMcpPlatform.backend("mcp_gemini");
    },
  },
  generalBackend: new BotConfiguredGeneralImageBackend(db),
  logger,
  isGroupEnabled: async (botId, chatId) => {
    const [row] = await db.select({ aiConfig: bots.aiConfig }).from(bots).where(eq(bots.id, botId));
    return row?.aiConfig?.groupOverrides?.[String(chatId)]?.imageGenerationEnabled === true;
  },
  delivery: {
    deliver: ({
      generationId,
      botId,
      chatId,
      threadId,
      prompt,
      presetKey,
      requestSnapshot,
      localFiles,
    }) =>
      botPool.sendImageFiles(
        botId,
        chatId,
        localFiles.map((file) => path.join(getDataDir(botId), "generations", file)),
        {
          prompt,
          presetKey,
          requestSnapshot,
          threadId,
          detailUrl: new URL(
            `/bots/${encodeURIComponent(botId)}/generations/unified/${encodeURIComponent(generationId)}`,
            env.BETTER_AUTH_URL,
          ).toString(),
        },
      ),
  },
});
botPool.setImageGenerationPort(imageGenerationService);
botPool.setUsageGovernance(usageGovernor);
const telegramDirectoryService = new TelegramDirectoryService(db);
const chatIdentityMigrationService = new ChatIdentityMigrationService(db);
const telegramRuntime = new BotPoolTelegramRuntimeAdapter(botPool);
const miniAppAccessService = new MiniAppAccessService(db, telegramRuntime);
const groupConfigService = new GroupConfigService(db, telegramRuntime, (botId, operation) =>
  botPool.withAiConfigLock(botId, operation),
);
const chatAiSelectionRuntimeRegistry = new ChatAiSelectionRuntimeRegistry();
const chatAiSelectionService = new ChatAiSelectionService(
  db,
  env.ENCRYPTION_KEY,
  chatAiSelectionRuntimeRegistry,
  (botId, operation) => botPool.withAiConfigLock(botId, operation),
);
botPool.setChatAiSelectionService(chatAiSelectionService, chatAiSelectionRuntimeRegistry);
const botLifecycleService = new BotLifecycleService(db, {
  getStatus: (botId) => botPool.getManager(botId)?.status ?? "stopped",
  start: (botId) => botPool.startBot(botId),
  stop: (botId) => botPool.stopBot(botId),
  restart: (botId) => botPool.restartBot(botId),
});
const botSettingsService = new BotSettingsService(db, botLifecycleService, (botId, operation) =>
  botPool.withAiConfigLock(botId, operation),
);
botPool.setTelegramDirectoryCallbacks(
  {
    onChatObserved: async (observation) => {
      await telegramDirectoryService.observeChat({
        botId: observation.botId,
        chatId: observation.chatId,
        type: observation.chatType,
        title: observation.title,
        username: observation.username ?? null,
        observedAt: new Date(observation.observedAt * 1000),
      });
    },
    onBotMembershipObserved: async (observation) => {
      await telegramDirectoryService.observeBotMembership({
        botId: observation.botId,
        chatId: observation.chatId,
        type: observation.chatType,
        title: null,
        username: null,
        status: observation.status,
        observedAt: new Date(observation.observedAt * 1000),
      });
    },
    onChatMigrationObserved: async (observation) => {
      const result = await chatIdentityMigrationService.migrate({
        botId: observation.botId,
        oldChatId: observation.oldChatId,
        newChatId: observation.newChatId,
        observedAt: observation.observedAt,
      });
      if (result.changed && botPool.getManager(observation.botId)) {
        // Do not await inside the Bot update callback: the queued restart waits
        // for this update to finish before stopping the current manager.
        void botPool.restartBot(observation.botId).catch((error) => {
          void dbLogger.error("Bot restart after Telegram chat migration failed", {
            botId: observation.botId,
            error: error instanceof Error ? error.message : String(error),
          });
        });
      }
    },
  },
  async (botId, profile) => {
    await telegramDirectoryService.upsertBotProfile({ botId, ...profile });
  },
);
const githubAppService = new GitHubAppCredentialService({
  config: {
    appId: env.GITHUB_APP_ID,
    clientId: env.GITHUB_APP_CLIENT_ID,
    clientSecret: env.GITHUB_APP_CLIENT_SECRET,
    privateKey: env.GITHUB_APP_PRIVATE_KEY,
    slug: env.GITHUB_APP_SLUG,
  },
  stateSecret: env.BETTER_AUTH_SECRET,
});
botPool.setGitHubAppCredentialService(githubAppService);
if (githubAppService.configurationError) {
  logger.warn(githubAppService.configurationError);
}
let harnessService: HarnessService | undefined;
let harnessAdmin: HarnessAdmin | undefined;
if (env.HARNESS_CONFIG_PATH) {
  const service: HarnessService = new HarnessService({
    configPath: env.HARNESS_CONFIG_PATH,
    store: new DrizzleHarnessStore(db),
    github: new GitHubAppHarnessClient(githubAppService, dbLogger),
    logger: dbLogger,
    panelUrl: env.BETTER_AUTH_URL,
    attachmentSecret: env.BETTER_AUTH_SECRET,
    summarizer: createPrSummarizer(async () => {
      const botId = service.botId;
      if (!botId) return null;
      const [row] = await db
        .select({ aiConfig: bots.aiConfig })
        .from(bots)
        .where(eq(bots.id, botId));
      return toAiConfigRuntime(row?.aiConfig, env.ENCRYPTION_KEY)?.activeProvider ?? null;
    }),
  });
  // Also built when init fails, so the panel can show the config error.
  harnessAdmin = new HarnessAdmin(service);
  if (await service.init()) {
    harnessService = service;
    botPool.setHarnessService(service);
    logger.info({ bot: service.file.telegram.bot }, "Dev Harness enabled");
  }
}
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
botPool.setPlugins(pluginManager);

// Summary Services
const summaryConfigService = new SummaryConfigService(db);

const summaryRunner = new SummaryRunner(
  db,
  logger,
  env.ENCRYPTION_KEY,
  async (botId) => {
    const [row] = await db
      .select({ aiConfig: bots.aiConfig, isActive: bots.isActive })
      .from(bots)
      .where(eq(bots.id, botId));
    if (!row?.isActive) return null;
    const cfg = row.aiConfig;
    if (!cfg) return null;
    return migrateAiConfig(cfg);
  },
  usageGovernor,
);
const memoryConsolidator = new MemoryConsolidator(
  db,
  logger,
  env.ENCRYPTION_KEY,
  usageGovernor,
  botPool.getBotMemoryWriter(),
);

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
      roleFilter: sc.roleFilter,
      timezone: sc.timezone,
    };
  },
);

botPool.setSummaryService(summaryService);
botPool.setSummaryConfigService(summaryConfigService);

// Hono App
const app = createApp({
  logger,
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
  pluginManager,
  mediaJobs: { jobs: mediaJobService, configuration: mediaConfiguration },
  asrSettings,
  asrAudioStore,
  summaryService,
  summaryConfigService,
  githubAppService,
  miniAppSessionSecret: env.MINI_APP_SESSION_SECRET,
  telegramDirectoryService,
  telegramMembershipVerifier: telegramRuntime,
  miniAppAccessService,
  groupConfigService,
  chatAiSelectionService,
  botLifecycleService,
  botSettingsService,
  imageGenerationService,
  imageMcpConnectionService,
  imageMcpConnections,
  imageMcpPlatform,
  usageGovernor,
  memoryConsolidationPreview: memoryConsolidator,
  engagementSampleService,
  runtimeHealth,
  harness: harnessService,
  harnessAdmin,
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
await usageGovernor.reclaimExpiredReservations();
await usageGovernor.pruneExpiredDetails();

// Start all active bots
await botPool.startAll();
if (!mediaConverter) await mediaJobService.cancelForBot();
await mediaJobService.start();
if (!mediaConverter) await videoDownloadService.cancelForBot();
await videoDownloadService.start();
await imageGenerationService.recoverPending();

const usageMaintenance = new UsageMaintenanceService(usageGovernor, logger);
usageMaintenance.start();

// Start RSS feed service (after bots so digest triggers have handlers)
rssFeedService.start();

// Start summary service (after bots so sendHtml has running managers)
summaryService.start();
memoryConsolidator.start();

// Register system timers
const scheduledServices: [
  string,
  { getHandle(): ReturnType<typeof setInterval> | null; getIntervalMs(): number },
][] = [
  ["LogCleaner", logCleaner],
  ["MemoryGC", memoryGC],
  ["MemoryConsolidator", memoryConsolidator],
  ["GenerationCleaner", generationCleaner],
  ["EngagementSampleCleaner", engagementSampleCleaner],
  ["ModelCapabilityService", modelCapabilityService],
];
for (const [name, svc] of scheduledServices) {
  const handle = svc.getHandle();
  if (handle) {
    timerRegistry.registerSystem({ name, intervalMs: svc.getIntervalMs(), handle });
  }
}
runtimeHealth.markReady();
logger.info({ version: runtimeHealth.snapshot().version }, "Application ready");

// Graceful shutdown
const shutdown = createShutdownHandler(async (signal) => {
  const steps = new ShutdownSteps();
  runtimeHealth.markStopping();
  const harnessStopped = steps.run("harness-scheduler", () => harnessService?.close());
  const timersStopped = steps.run("timerRegistry", () => timerRegistry.close());
  const usageStopped = steps.run("usage-maintenance", () => usageMaintenance.close());
  const rssStopped = steps.run("rss", () => rssFeedService.close());
  const summariesStopped = steps.run("summaries", () => summaryService.close());
  const memoriesStopped = steps.run("memory-consolidation", () => memoryConsolidator.close());
  await steps.run("shutdown-log", () => dbLogger.info(`[${signal}] Shutting down...`));
  // Digests, summaries and reminders use Bot AI tools through delivery and persistence.
  await Promise.all([rssStopped, summariesStopped, timersStopped]);
  const imagesStopped = steps.run("images", () => imageGenerationService.close());
  await steps.run("media-jobs", () => mediaJobService.close());
  await steps.run("video-downloads", () => videoDownloadService.close());
  await steps.run("plugins", () => pluginManager.close());
  await imagesStopped;
  await steps.run("mcp", () => mcpClientManager.destroyAll());
  await steps.run("image-mcp", () => imageMcpPlatform.close());
  await usageStopped;
  await harnessStopped;
  await steps.run("modelCapabilityService", () => modelCapabilityService.stop());
  await steps.run("logCleaner", () => logCleaner.close());
  await steps.run("botRunCleaner", () => botRunCleaner.close());
  await steps.run("memoryGC", () => memoryGC.close());
  await memoriesStopped;
  await steps.run("generationCleaner", () => generationCleaner.close());
  await steps.run("engagementSampleCleaner", () => engagementSampleCleaner.close());
  await steps.run("bots", () => botPool.stopAll());
  await steps.run("database", () => dbClient.end());
  for (const { step, error } of steps.failures) {
    logger.error({ step, err: redactDiagnostic(error) }, "Shutdown step failed");
  }
  process.exit(steps.failures.length > 0 ? 1 : 0);
});

process.once("SIGINT", () => shutdown("SIGINT"));
process.once("SIGTERM", () => shutdown("SIGTERM"));
