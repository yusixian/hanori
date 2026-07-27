import type {
  BotLogEntry,
  ConversationCallbacks,
  PixAIGenerationRecord,
  TokenUsageRecord,
  UserPrivacyCallbacks,
} from "@cos-tool-bot/shared";
import { DEFAULT_CONVERSATION_CONFIG, DEFAULT_MEMORY_CONFIG } from "@cos-tool-bot/shared";
import { autoRetry } from "@grammyjs/auto-retry";
import { sequentialize } from "@grammyjs/runner";
import { stream } from "@grammyjs/stream";
import { Bot, GrammyError, HttpError } from "grammy";
import type { Logger } from "pino";
import { type BackupResult, createBackupCommand } from "./commands/backup.js";
import { createApiKeyCommand } from "./commands/api-key.js";
import { createClearCommand } from "./commands/clear.js";
import { createSummaryCommand, type SummaryCallbacks } from "./commands/summary.js";
import { createClearReceivedCommand } from "./commands/clear-received.js";
import { createDrawCommand } from "./commands/draw.js";
import { createHelpCommand } from "./commands/help.js";
import { createMd2tgCommand } from "./commands/md2tg.js";
import { createModelCommand } from "./commands/model.js";
import { createProviderCommand } from "./commands/provider.js";
import { createPrivacyCommand } from "./commands/privacy.js";
import { createImageGenCommand } from "./commands/imagegen.js";
import { type McpCommandConfig, createMcpCommand } from "./commands/mcp.js";
import { createImgCfgCommand } from "./commands/imgcfg.js";
import { createReplyModeCommand } from "./commands/reply-mode.js";
import { createRichTextCommand } from "./commands/rich-text.js";
import { createRestartCommand } from "./commands/restart.js";
import { createResumeCommand } from "./commands/resume.js";
import { startCommand } from "./commands/start.js";
import { createStatusCommand } from "./commands/status.js";
import { createStopCommand } from "./commands/stop.js";
import { ActiveCommandRegistry } from "./commands/registry.js";
import {
  createTimersCommand,
  isTimerCancelCallback,
  parseTimerCancelId,
} from "./commands/timers.js";
import { WrapperContext, type BotContext } from "./context.js";
import { createAuthGuard } from "./guards/auth.js";
import { type AiReplyConfig, createAiReplyHandler } from "./handlers/ai-reply.js";
import {
  createPollAnswerHandler,
  createCallbackQueryHandler,
  createGitHubCallbackQueryHandler,
} from "./handlers/event-handlers.js";
import { createLogMiddleware } from "./middleware/log.js";
import {
  createTelegramObservationMiddleware,
  type TelegramObservationCallbacks,
} from "./middleware/telegram-observation.js";
import { getUpdateConstraint } from "./middleware/update-constraint.js";

export type AiReplyBotConfig = Omit<
  AiReplyConfig,
  "adminChatIds" | "onLog" | "onTokenUsage" | "onGenerationTrack" | "token"
>;

export interface BotTimerHandlers {
  fireTimer: (
    chatId: number,
    timerId: string,
    reason: string,
    userId?: number,
    memoryless?: boolean,
  ) => void;
  cancelPendingTimer: (timerId: string) => void;
}

export interface TimerCallbacks {
  onTimerCreate?: (params: {
    timerId: string;
    chatId: number;
    seconds: number;
    reason: string;
    userId: number;
  }) => void;
  onTimerCancel?: (timerId: string) => void;
  onTimerFired?: (timerId: string) => void;
  onGetTimers?: () => import("@cos-tool-bot/shared").TimerRecord[];
  onCancelTimer?: (timerId: string) => Promise<boolean>;
  onBotReady?: (handlers: BotTimerHandlers) => void;
}

export interface BotConfig {
  token: string;
  botId: string;
  adminChatIds: number[];
  logger: Logger;
  onRestart?: () => void | Promise<void>;
  onBackup?: () => Promise<BackupResult>;
  onLog?: (entry: BotLogEntry) => void | Promise<void>;
  onTokenUsage?: (entry: TokenUsageRecord) => void | Promise<void>;
  onGenerationTrack?: (record: PixAIGenerationRecord) => void | Promise<void>;
  timerCallbacks?: TimerCallbacks;
  mcpCallbacks?: McpCommandConfig;
  aiReply?: AiReplyBotConfig;
  conversation?: ConversationCallbacks;
  privacy?: UserPrivacyCallbacks;
  summary?: SummaryCallbacks;
  telegramObservation?: TelegramObservationCallbacks;
}

const botDisposers = new WeakMap<object, () => void>();

export function disposeBot(bot: object): void {
  const dispose = botDisposers.get(bot);
  if (!dispose) return;
  botDisposers.delete(bot);
  dispose();
}

export function createBot(config: BotConfig) {
  const { token, adminChatIds, logger } = config;

  // StreamFlavor adds plain and Rich Message streaming methods at runtime via stream() middleware,
  // so we need a double assertion to satisfy the type system while using our custom WrapperContext
  const bot = new Bot<BotContext>(token, {
    ContextConstructor: WrapperContext as unknown as new (
      ...args: ConstructorParameters<typeof WrapperContext>
    ) => BotContext,
  });
  bot.api.config.use(autoRetry());
  const commandRegistry = new ActiveCommandRegistry(bot);

  const authGuard = createAuthGuard(adminChatIds);

  // Serialize updates per chat so streamText calls for the same chat don't race,
  // but allow different chats to run concurrently. Kill-switch commands bypass
  // the constraint; /apikey uses its own bot-global queue so it can bypass a stuck
  // AI reply without racing another full-config API key update from a different chat.
  bot.use(sequentialize(getUpdateConstraint));
  bot.use(stream());
  bot.use(
    createTelegramObservationMiddleware(config.botId, config.telegramObservation, config.onLog),
  );
  bot.use(createLogMiddleware(config.onLog));

  // Build AI handler + runtime state (created before commands so state is available)
  let aiHandler: ReturnType<typeof createAiReplyHandler>["handler"] | undefined;
  let aiState: ReturnType<typeof createAiReplyHandler>["state"] | undefined;
  let aiSetModelForChat: ReturnType<typeof createAiReplyHandler>["setModelForChat"] | undefined;
  let aiGetModelForChat: ReturnType<typeof createAiReplyHandler>["getModelForChat"] | undefined;
  let aiResetModelForChat: ReturnType<typeof createAiReplyHandler>["resetModelForChat"] | undefined;
  let aiSetProviderForChat:
    | ReturnType<typeof createAiReplyHandler>["setProviderForChat"]
    | undefined;
  let aiGetProviderForChat:
    | ReturnType<typeof createAiReplyHandler>["getProviderForChat"]
    | undefined;
  let aiResetProviderForChat:
    | ReturnType<typeof createAiReplyHandler>["resetProviderForChat"]
    | undefined;
  let aiGetProvidersList: ReturnType<typeof createAiReplyHandler>["getProvidersList"] | undefined;
  let aiGetModelsForChat: ReturnType<typeof createAiReplyHandler>["getModelsForChat"] | undefined;
  let aiGetReplyMode: ReturnType<typeof createAiReplyHandler>["getReplyMode"] | undefined;
  let aiSetReplyMode: ReturnType<typeof createAiReplyHandler>["setReplyMode"] | undefined;
  let aiGetRichMessageEnabled:
    | ReturnType<typeof createAiReplyHandler>["getRichMessageEnabled"]
    | undefined;
  let aiSetRichMessageEnabled:
    | ReturnType<typeof createAiReplyHandler>["setRichMessageEnabled"]
    | undefined;
  let aiGetImageGenEnabled:
    | ReturnType<typeof createAiReplyHandler>["getImageGenEnabled"]
    | undefined;
  let aiSetImageGenEnabled:
    | ReturnType<typeof createAiReplyHandler>["setImageGenEnabled"]
    | undefined;
  let aiGetPixaiFullConfig:
    | ReturnType<typeof createAiReplyHandler>["getPixaiFullConfig"]
    | undefined;
  let aiUpdatePixaiConfig: ReturnType<typeof createAiReplyHandler>["updatePixaiConfig"] | undefined;
  let aiUpdateWebToolApiKey:
    | ReturnType<typeof createAiReplyHandler>["updateWebToolApiKey"]
    | undefined;
  let aiGetPixaiRateLimitStats:
    | ReturnType<typeof createAiReplyHandler>["getPixaiRateLimitStats"]
    | undefined;
  let aiDirectGenerate: ReturnType<typeof createAiReplyHandler>["directGenerate"] | undefined;
  let aiCanUseImageGeneration:
    | ReturnType<typeof createAiReplyHandler>["canUseImageGeneration"]
    | undefined;
  let aiSetAiEnabled: ReturnType<typeof createAiReplyHandler>["setAiEnabled"] | undefined;
  let aiWaitForUserProfileUpdates:
    | ReturnType<typeof createAiReplyHandler>["waitForUserProfileUpdates"]
    | undefined;
  let disposeAiRuntime: (() => void) | undefined;
  let statusConfig: Parameters<typeof createStatusCommand>[0];

  if (config.aiReply) {
    const convCfg = config.aiReply.conversationConfig ?? DEFAULT_CONVERSATION_CONFIG;
    const memCfg = config.aiReply.memoryConfig ?? DEFAULT_MEMORY_CONFIG;
    statusConfig = {
      model: config.aiReply.model,
      conversationEnabled: convCfg.enabled,
      memoryEnabled: memCfg.enabled,
      webToolsEnabled: !!config.aiReply.webToolsConfig?.enabled,
      agentToolsEnabled: !!config.aiReply.agentToolsConfig?.enabled,
      stickerPacksCount: config.aiReply.stickerPacks?.length ?? 0,
    };
    const result = createAiReplyHandler({
      ...config.aiReply,
      privacy: config.privacy,
      adminChatIds,
      onLog: config.onLog,
      onTokenUsage: config.onTokenUsage,
      onGenerationTrack: config.onGenerationTrack,
      onTimerCreate: config.timerCallbacks?.onTimerCreate,
      onTimerCancel: config.timerCallbacks?.onTimerCancel,
      onTimerFiredPersist: config.timerCallbacks?.onTimerFired,
      token,
      initialApi: bot.api,
    });
    aiHandler = result.handler;
    aiState = result.state;
    aiSetModelForChat = result.setModelForChat;
    aiGetModelForChat = result.getModelForChat;
    aiResetModelForChat = result.resetModelForChat;
    aiSetProviderForChat = result.setProviderForChat;
    aiGetProviderForChat = result.getProviderForChat;
    aiResetProviderForChat = result.resetProviderForChat;
    aiGetProvidersList = result.getProvidersList;
    aiGetModelsForChat = result.getModelsForChat;
    aiGetReplyMode = result.getReplyMode;
    aiSetReplyMode = result.setReplyMode;
    aiGetRichMessageEnabled = result.getRichMessageEnabled;
    aiSetRichMessageEnabled = result.setRichMessageEnabled;
    aiGetImageGenEnabled = result.getImageGenEnabled;
    aiSetImageGenEnabled = result.setImageGenEnabled;
    aiGetPixaiFullConfig = result.getPixaiFullConfig;
    aiUpdatePixaiConfig = result.updatePixaiConfig;
    aiUpdateWebToolApiKey = result.updateWebToolApiKey;
    aiGetPixaiRateLimitStats = result.getPixaiRateLimitStats;
    aiDirectGenerate = result.directGenerate;
    aiCanUseImageGeneration = result.canUseImageGeneration;
    aiSetAiEnabled = result.setAiEnabled;
    aiWaitForUserProfileUpdates = result.waitForUserProfileUpdates;
    disposeAiRuntime = result.destroy;

    // Register bot handlers with server for timer recovery and external cancel
    if (config.timerCallbacks?.onBotReady) {
      const pendingActions = result.state.getPendingActions();
      config.timerCallbacks.onBotReady({
        fireTimer: result.fireTimerEvent,
        cancelPendingTimer: (timerId) => {
          pendingActions.removeTimer(timerId);
        },
      });
    }
  }

  commandRegistry.register("start", startCommand);
  commandRegistry.register(
    "help",
    createHelpCommand(() => commandRegistry.getActiveCommands()),
  );
  commandRegistry.register(
    "md2tg",
    createMd2tgCommand({ getRichMessageEnabled: () => aiGetRichMessageEnabled?.() ?? false }),
  );
  commandRegistry.register("status", authGuard, createStatusCommand(statusConfig, aiState));
  commandRegistry.register("restart", authGuard, createRestartCommand(config.onRestart));
  commandRegistry.register("backup", authGuard, createBackupCommand(config.onBackup));
  if (aiSetAiEnabled) {
    commandRegistry.register("stop", authGuard, createStopCommand(aiSetAiEnabled));
    commandRegistry.register("resume", authGuard, createResumeCommand(aiSetAiEnabled));
  }
  if (aiUpdateWebToolApiKey) {
    commandRegistry.register(
      "apikey",
      authGuard,
      createApiKeyCommand({
        updateApiKey: aiUpdateWebToolApiKey,
        onError: (target) =>
          config.onLog?.({
            level: "error",
            message: `Failed to update ${target} API key`,
          }),
      }),
    );
  }
  if (config.mcpCallbacks) {
    commandRegistry.register("mcp", authGuard, createMcpCommand(config.mcpCallbacks));
  }
  commandRegistry.register("clear", createClearCommand(config.conversation, adminChatIds));
  if (config.privacy) {
    commandRegistry.register(
      "privacy",
      createPrivacyCommand({
        ...config.privacy,
        waitForPendingProfileUpdate: aiWaitForUserProfileUpdates,
      }),
    );
  }
  commandRegistry.register(
    "clearreceived",
    authGuard,
    createClearReceivedCommand(config.aiReply?.dataFiles?.dataDir),
  );

  // Register /timers command (admin only)
  if (config.timerCallbacks?.onGetTimers && config.timerCallbacks?.onCancelTimer) {
    commandRegistry.register(
      "timers",
      authGuard,
      createTimersCommand({
        onGetTimers: config.timerCallbacks.onGetTimers,
        onCancelTimer: config.timerCallbacks.onCancelTimer,
      }),
    );
  }

  // Register /model command if models are configured
  if (config.aiReply?.models?.length && aiSetModelForChat && aiGetModelForChat) {
    const modelAccess = config.aiReply.modelCommandAccess ?? "admin";
    const modelCmd = createModelCommand({
      getModelForChat: aiGetModelForChat,
      setModelForChat: aiSetModelForChat,
      resetModelForChat: aiResetModelForChat,
      models: config.aiReply.models,
      defaultModel: config.aiReply.model,
      getModelsForChat: aiGetModelsForChat,
    });
    if (modelAccess === "admin") {
      commandRegistry.registerConfigurable("model", "admin", authGuard, modelCmd);
    } else {
      commandRegistry.registerConfigurable("model", "public", modelCmd);
    }
  }

  // Register /provider command if providers are configured (shares modelCommandAccess gate)
  const providersList: Array<{ id: string; label: string; defaultModel: string }> =
    aiGetProvidersList?.() ?? [];
  if (
    providersList.length > 1 &&
    aiSetProviderForChat &&
    aiGetProviderForChat &&
    aiResetProviderForChat
  ) {
    const providerAccess = config.aiReply?.modelCommandAccess ?? "admin";
    const defaultProviderId =
      config.aiReply?.activeProviderId &&
      providersList.some((p) => p.id === config.aiReply!.activeProviderId)
        ? config.aiReply.activeProviderId
        : providersList[0]!.id;
    const providerCmd = createProviderCommand({
      getProviderForChat: aiGetProviderForChat,
      setProviderForChat: aiSetProviderForChat,
      resetProviderForChat: aiResetProviderForChat,
      providers: providersList,
      defaultProviderId,
    });
    if (providerAccess === "admin") {
      commandRegistry.registerConfigurable("provider", "admin", authGuard, providerCmd);
    } else {
      commandRegistry.registerConfigurable("provider", "public", providerCmd);
    }
  }

  // Register /replymode command (admin only)
  if (config.aiReply && aiGetReplyMode && aiSetReplyMode) {
    commandRegistry.register(
      "replymode",
      authGuard,
      createReplyModeCommand({
        getReplyMode: aiGetReplyMode,
        setReplyMode: aiSetReplyMode,
      }),
    );
  }

  // Register /richtext command (admin only, persisted globally for this bot)
  if (aiGetRichMessageEnabled && aiSetRichMessageEnabled) {
    commandRegistry.register(
      "richtext",
      authGuard,
      createRichTextCommand({
        getEnabled: aiGetRichMessageEnabled,
        setEnabled: aiSetRichMessageEnabled,
      }),
    );
  }

  // Register /imagegen command (admin only, requires image generation config)
  if (
    config.aiReply?.webToolsConfig?.imageGeneration &&
    aiGetImageGenEnabled &&
    aiSetImageGenEnabled
  ) {
    commandRegistry.register(
      "imagegen",
      authGuard,
      createImageGenCommand({
        getImageGenEnabled: aiGetImageGenEnabled,
        setImageGenEnabled: aiSetImageGenEnabled,
      }),
    );
  }

  // Register /imgcfg command (admin only, requires pixai provider)
  if (
    config.aiReply?.webToolsConfig?.imageGeneration?.provider === "pixai" &&
    aiGetPixaiFullConfig &&
    aiUpdatePixaiConfig
  ) {
    commandRegistry.register(
      "imgcfg",
      authGuard,
      createImgCfgCommand({
        getFullConfig: aiGetPixaiFullConfig,
        updateConfig: aiUpdatePixaiConfig,
        getRateLimitStats: aiGetPixaiRateLimitStats,
      }),
    );
  }

  // Register /draw command (requires pixai provider + directGenerate)
  if (
    config.aiReply?.webToolsConfig?.imageGeneration?.provider === "pixai" &&
    aiDirectGenerate &&
    aiCanUseImageGeneration
  ) {
    commandRegistry.register(
      "draw",
      createDrawCommand({
        directGenerate: aiDirectGenerate,
        canUseImageGeneration: aiCanUseImageGeneration,
        adminIds: adminChatIds,
      }),
    );
  }

  if (config.summary) {
    commandRegistry.register("summary", createSummaryCommand(config.summary));
  }

  if (aiHandler && aiState) {
    // Register event handlers for interactive tools (polls, choices)
    const pendingActions = aiState.getPendingActions();

    const pollAnswerHandler = createPollAnswerHandler({
      api: bot.api,
      pendingActions,
      getContinueChatConfig: (chatId) => aiState!.getContinueChatConfig(chatId),
      isPrivateChat: (chatId) => aiState!.isPrivateChat(chatId),
    });

    const callbackQueryHandler = createCallbackQueryHandler({
      api: bot.api,
      pendingActions,
      getContinueChatConfig: (chatId) => aiState!.getContinueChatConfig(chatId),
    });
    const githubCallbackQueryHandler = createGitHubCallbackQueryHandler({
      api: bot.api,
      pendingActions: aiState.getPendingGitHubActions(),
      adminIds: adminChatIds,
    });

    bot.on("poll_answer", async (ctx) => {
      await pollAnswerHandler(ctx.pollAnswer);
    });

    bot.on("callback_query:data", async (ctx) => {
      // Handle timer cancel callbacks
      const data = ctx.callbackQuery.data;
      if (isTimerCancelCallback(data) && config.timerCallbacks?.onCancelTimer) {
        const timerId = parseTimerCancelId(data);
        if (timerId) {
          const cancelled = await config.timerCallbacks.onCancelTimer(timerId);
          await ctx.api.raw.answerCallbackQuery({
            callback_query_id: ctx.callbackQuery.id,
            text: cancelled ? `定时器 ${timerId} 已取消` : "定时器未找到或已过期",
          });
          if (cancelled && ctx.callbackQuery.message) {
            try {
              await ctx.api.editMessageText(
                ctx.callbackQuery.message.chat.id,
                ctx.callbackQuery.message.message_id,
                `${ctx.callbackQuery.message.text ?? ""}\n\n✅ 定时器 ${timerId} 已取消`,
              );
            } catch {
              // ignore edit errors
            }
          }
          return;
        }
      }
      if (await githubCallbackQueryHandler(ctx)) return;
      await callbackQueryHandler(ctx);
    });

    bot.on("message", aiHandler);
  }

  bot.api.setMyCommands(commandRegistry.getTelegramCommands()).catch((err) => {
    const desc = err instanceof GrammyError ? err.description : String(err);
    logger.warn(`Failed to set commands: ${desc}`);
  });

  bot.catch(async (err) => {
    const ctx = err.ctx;
    const errorMsg = buildUpdateErrorMessage(ctx.update.update_id, err.error);
    logger.error(errorMsg);
    config.onLog?.({ level: "error", message: errorMsg, meta: { updateId: ctx.update.update_id } });
    // Plain text on purpose: error descriptions are arbitrary strings and must
    // never be re-parsed as Markdown/HTML, or the error report itself fails.
    await ctx.resolveWait(errorMsg).catch(() => {});
  });

  botDisposers.set(bot, () => disposeAiRuntime?.());
  return bot;
}

export function buildUpdateErrorMessage(updateId: number, error: unknown): string {
  const head = `处理消息 ${updateId} 时出错:\n`;
  if (error instanceof GrammyError) return head + "Error in request: " + error.description;
  if (error instanceof HttpError) return head + "Could not contact Telegram: " + error;
  return head + "Unknown error: " + ((error as Error)?.message ?? String(error));
}

export { WrapperContext, type BotContext } from "./context.js";
export {
  buildPromptBundle,
  appendCurrentRequest,
  assemblePromptPreview,
  type CompletedPromptBundle,
  type ContextAssemblyInput,
  type PromptBundle,
  type PromptPreviewInput,
  type PromptPreviewResult,
  type PromptSectionStatus,
  type PromptSectionTrace,
  type PromptStability,
  type PromptTrace,
  type PromptTrust,
} from "./services/context-assembler.js";
export type { McpCommandConfig } from "./commands/mcp.js";
export type { SummaryCallbacks } from "./commands/summary.js";
export {
  createTelegramObservationMiddleware,
  isValidTelegramGroupChatId,
  projectTelegramObservations,
  type TelegramBotMembershipObservation,
  type TelegramBotMembershipStatus,
  type TelegramChatMigrationObservation,
  type TelegramChatObservation,
  type TelegramGroupChatType,
  type TelegramObservationCallbacks,
} from "./middleware/telegram-observation.js";
export type { DataFilesConfig } from "./utils/data-files.js";
export { getActiveBotCommands } from "./commands/registry.js";
export { NsfwChecker } from "./services/nsfw-checker.js";
export type { NsfwCheckerConfig, NsfwCheckResult } from "./services/nsfw-checker.js";
export {
  cleanupBotAvatarFiles,
  cleanupProfileAvatarFiles,
  removeProfileAvatarFile,
} from "./services/profile-avatar-files.js";
export {
  isTerminalPixAIRecoveryError,
  PixAIRecoveryTerminalError,
  PixAITaskTerminalError,
  recoverPixAIGeneration,
  type PixAIRecoveryTerminalReason,
  type PixAITaskTerminalStatus,
  type RecoverPixAIGenerationOptions,
} from "./tools/pixai.js";
