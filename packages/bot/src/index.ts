import type {
  BotLogEntry,
  ConversationCallbacks,
  PixAIGenerationRecord,
  TokenUsageRecord,
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
import { commands, helpCommand } from "./commands/help.js";
import { md2tgCommand } from "./commands/md2tg.js";
import { createModelCommand } from "./commands/model.js";
import { createProviderCommand } from "./commands/provider.js";
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
import {
  createTimersCommand,
  isTimerCancelCallback,
  parseTimerCancelId,
} from "./commands/timers.js";
import { WrapperContext, type BotContext } from "./context.js";
import { createAuthGuard } from "./guards/auth.js";
import { type AiReplyConfig, createAiReplyHandler } from "./handlers/ai-reply.js";
import { createPollAnswerHandler, createCallbackQueryHandler } from "./handlers/event-handlers.js";
import { createLogMiddleware } from "./middleware/log.js";
import { getUpdateConstraint } from "./middleware/update-constraint.js";

export type AiReplyBotConfig = Omit<
  AiReplyConfig,
  "adminChatIds" | "onLog" | "onTokenUsage" | "onGenerationTrack" | "token"
>;

export interface BotTimerHandlers {
  fireTimer: (chatId: number, timerId: string, reason: string) => void;
  cancelPendingTimer: (timerId: string) => void;
}

export interface TimerCallbacks {
  onTimerCreate?: (params: {
    timerId: string;
    chatId: number;
    seconds: number;
    reason: string;
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
  summary?: SummaryCallbacks;
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

  const authGuard = createAuthGuard(adminChatIds);

  // Serialize updates per chat so streamText calls for the same chat don't race,
  // but allow different chats to run concurrently. Kill-switch commands bypass
  // the constraint; /apikey uses its own bot-global queue so it can bypass a stuck
  // AI reply without racing another full-config API key update from a different chat.
  bot.use(sequentialize(getUpdateConstraint));
  bot.use(stream());
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

  bot.command("start", startCommand);
  bot.command("help", helpCommand);
  bot.command("md2tg", md2tgCommand);
  bot.command("status", authGuard, createStatusCommand(statusConfig, aiState));
  bot.command("restart", authGuard, createRestartCommand(config.onRestart));
  bot.command("backup", authGuard, createBackupCommand(config.onBackup));
  if (aiSetAiEnabled) {
    bot.command("stop", authGuard, createStopCommand(aiSetAiEnabled));
    bot.command("resume", authGuard, createResumeCommand(aiSetAiEnabled));
  }
  if (aiUpdateWebToolApiKey) {
    bot.command(
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
    bot.command("mcp", authGuard, createMcpCommand(config.mcpCallbacks));
  }
  bot.command("clear", createClearCommand(config.conversation, adminChatIds));
  bot.command(
    "clearreceived",
    authGuard,
    createClearReceivedCommand(config.aiReply?.dataFiles?.dataDir),
  );

  // Register /timers command (admin only)
  if (config.timerCallbacks?.onGetTimers && config.timerCallbacks?.onCancelTimer) {
    bot.command(
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
      bot.command("model", authGuard, modelCmd);
    } else {
      bot.command("model", modelCmd);
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
      bot.command("provider", authGuard, providerCmd);
    } else {
      bot.command("provider", providerCmd);
    }
  }

  // Register /replymode command (admin only)
  if (config.aiReply && aiGetReplyMode && aiSetReplyMode) {
    bot.command(
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
    bot.command(
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
    bot.command(
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
    bot.command(
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
    bot.command(
      "draw",
      createDrawCommand({
        directGenerate: aiDirectGenerate,
        canUseImageGeneration: aiCanUseImageGeneration,
        adminIds: adminChatIds,
      }),
    );
  }

  if (config.summary) {
    bot.command("summary", createSummaryCommand(config.summary));
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
      await callbackQueryHandler(ctx);
    });

    bot.on("message", aiHandler);
  }

  bot.api.setMyCommands(commands).catch((err) => {
    const desc = err instanceof GrammyError ? err.description : String(err);
    logger.warn(`Failed to set commands: ${desc}`);
  });

  bot.catch(async (err) => {
    const ctx = err.ctx;
    let errorMsg = "处理消息 " + ctx.update.update_id + " 时出错:\n```\n";

    const e = err.error;
    if (e instanceof GrammyError) {
      errorMsg += "Error in request:" + e.description;
    } else if (e instanceof HttpError) {
      errorMsg += "Could not contact Telegram:" + e;
    } else {
      errorMsg += "Unknown error:" + ((e as Error)?.message ?? String(e));
    }
    errorMsg += "\n```";
    logger.error(errorMsg);
    config.onLog?.({ level: "error", message: errorMsg, meta: { updateId: ctx.update.update_id } });
    await ctx.resolveWait(errorMsg, "Markdown").catch(() => {});
  });

  return bot;
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
export type { DataFilesConfig } from "./utils/data-files.js";
export { NsfwChecker } from "./services/nsfw-checker.js";
export type { NsfwCheckerConfig, NsfwCheckResult } from "./services/nsfw-checker.js";
export {
  cleanupBotAvatarFiles,
  cleanupProfileAvatarFiles,
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
