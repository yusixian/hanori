import { tokenUsage } from "@cos-tool-bot/database";
import type { TokenUsageRecord } from "@cos-tool-bot/shared";
import type { ChatSummaryService } from "../chat-summary-service.js";
import { assembleAiReply } from "./ai-reply.js";
import { createRuntimeDiagnostics } from "./diagnostics.js";
import { createPrivacyCallbacks } from "./conversation.js";
import { createCosInsideConfig } from "./cos-inside.js";
import { createGenerationTracker } from "./generation-tracking.js";
import { createMcpCallbacks } from "./mcp.js";
import { createQuotaConfig } from "./quota.js";
import { createTimerCallbacks } from "./timers.js";
import type { BotRuntime, BotRuntimeHost, BotRuntimeInput, BotRuntimeServices } from "./types.js";

export type {
  BotRuntime,
  BotRuntimeHost,
  BotRuntimeInput,
  BotRuntimeServices,
  ChatAiSelectionPort,
} from "./types.js";

/**
 * Turns a Telegram Bot row and its decrypted configuration into BotManager's inputs plus the
 * artefacts BotPool's lifecycle registers once the Bot runs. Callbacks reach BotPool only
 * through `host`. The Harness is claimed last, so a failed assembly leaves it unbound.
 */
export async function assembleBotRuntime(
  { bot, token, aiRuntime, dbLogger, miniAppUrl }: BotRuntimeInput,
  services: Readonly<BotRuntimeServices>,
  host: BotRuntimeHost,
): Promise<BotRuntime> {
  const botId = bot.id;
  const diagnostics = createRuntimeDiagnostics({ bot, token, aiRuntime }, services, host);
  const privacy = createPrivacyCallbacks(botId, services.userPrivacyService, dbLogger);
  const ai = aiRuntime
    ? await assembleAiReply(botId, aiRuntime, dbLogger, services, host)
    : undefined;

  const backupSvc = services.backupService;
  const onBackup = backupSvc
    ? async () => {
        try {
          const record = await backupSvc.createBackup();
          return { ok: true, filename: record.filename };
        } catch (err) {
          return { ok: false, error: err instanceof Error ? err.message : String(err) };
        }
      }
    : undefined;

  const onTokenUsage = async (entry: TokenUsageRecord) => {
    try {
      await services.db.insert(tokenUsage).values({ botId, ...entry });
    } catch (err) {
      services.logger.error(err, "Failed to write token usage");
    }
  };

  const onGenerationTrack = createGenerationTracker(botId, services);
  const timerCallbacks = createTimerCallbacks(botId, services.timerRegistry, services.logger, host);
  const mcpCallbacks = createMcpCallbacks(botId, services, host);

  const summaryCallbacks =
    services.summaryService && services.summaryConfigService
      ? {
          botId,
          adminChatIds: bot.adminChatIds ?? [],
          triggerManual: (opts: Parameters<ChatSummaryService["triggerManual"]>[0]) =>
            services.summaryService!.triggerManual(opts),
          getAccessMode: async (chatId: number) => {
            const cfg = await services.summaryConfigService!.getByChat(botId, chatId);
            return cfg?.accessMode ?? null;
          },
        }
      : undefined;

  const cosInside = createCosInsideConfig({
    botId,
    targets: bot.cosInsideConfig?.targets ?? [],
    aiReply: ai?.aiReply,
    conversation: ai?.conversation,
    dbLogger,
    db: services.db,
  });

  return {
    config: {
      botId,
      scheduledTasks: services.scheduledTasks,
      nsfwChecker: services.nsfwChecker,
      nsfwThreshold: aiRuntime?.config.webToolsConfig?.imageGeneration?.pixaiConfig?.nsfwThreshold,
      runtimeDiagnostics: diagnostics,
      token,
      adminChatIds: bot.adminChatIds,
      logger: services.logger,
      aiReply: ai?.aiReply,
      githubIssueProposals: services.githubIssueProposalService?.forBot(botId),
      mediaTranscriptionPort: services.mediaTranscriptionPort,
      aiSelectionCallbacks: ai?.aiSelectionCallbacks,
      conversation: ai?.conversation,
      privacy,
      onRestart: () => host.restartBot(botId),
      onBackup,
      onTokenUsage,
      timerCallbacks,
      mcpCallbacks,
      summary: summaryCallbacks,
      quota: createQuotaConfig(botId, bot.adminChatIds, services, host),
      telegramObservation: services.telegramObservation,
      miniAppUrl,
      cosInside,
      harness: services.harnessService?.claimBot({
        id: botId,
        name: bot.name,
        miniApp: miniAppUrl !== undefined,
      }),
    },
    managerOptions: {
      dbLogger,
      onGenerationTrack,
      imageGenerationReceiptConfig: aiRuntime?.config.imageGenerationReceiptConfig,
    },
    embeddingService: ai?.embeddingService,
    runInitialHistoryGovernance: ai?.runInitialHistoryGovernance,
  };
}
