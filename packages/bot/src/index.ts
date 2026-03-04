import type {
  BotLogEntry,
  ConversationCallbacks,
  PixAIGenerationRecord,
  TokenUsageRecord,
} from "@cos-tool-bot/shared";
import { DEFAULT_CONVERSATION_CONFIG, DEFAULT_MEMORY_CONFIG } from "@cos-tool-bot/shared";
import { autoRetry } from "@grammyjs/auto-retry";
import { stream } from "@grammyjs/stream";
import { Bot, GrammyError, HttpError } from "grammy";
import type { Logger } from "pino";
import { type BackupResult, createBackupCommand } from "./commands/backup.js";
import { createClearCommand } from "./commands/clear.js";
import { createClearReceivedCommand } from "./commands/clear-received.js";
import { createDrawCommand } from "./commands/draw.js";
import { commands, helpCommand } from "./commands/help.js";
import { md2tgCommand } from "./commands/md2tg.js";
import { createModelCommand } from "./commands/model.js";
import { createImageGenCommand } from "./commands/imagegen.js";
import { createImgCfgCommand } from "./commands/imgcfg.js";
import { createReplyModeCommand } from "./commands/reply-mode.js";
import { createRestartCommand } from "./commands/restart.js";
import { startCommand } from "./commands/start.js";
import { createStatusCommand } from "./commands/status.js";
import { WrapperContext, type BotContext } from "./context.js";
import { createAuthGuard } from "./guards/auth.js";
import { type AiReplyConfig, createAiReplyHandler } from "./handlers/ai-reply.js";
import { createPollAnswerHandler, createCallbackQueryHandler } from "./handlers/event-handlers.js";
import { createLogMiddleware } from "./middleware/log.js";

export type AiReplyBotConfig = Omit<
  AiReplyConfig,
  "adminChatIds" | "onLog" | "onTokenUsage" | "onGenerationTrack" | "token"
>;

export interface BotConfig {
  token: string;
  adminChatIds: number[];
  logger: Logger;
  onRestart?: () => void | Promise<void>;
  onBackup?: () => Promise<BackupResult>;
  onLog?: (entry: BotLogEntry) => void | Promise<void>;
  onTokenUsage?: (entry: TokenUsageRecord) => void | Promise<void>;
  onGenerationTrack?: (record: PixAIGenerationRecord) => void | Promise<void>;
  aiReply?: AiReplyBotConfig;
  conversation?: ConversationCallbacks;
}

export function createBot(config: BotConfig) {
  const { token, adminChatIds, logger } = config;

  // StreamFlavor adds replyWithStream which is injected at runtime by stream() middleware,
  // so we need a double assertion to satisfy the type system while using our custom WrapperContext
  const bot = new Bot<BotContext>(token, {
    ContextConstructor: WrapperContext as unknown as new (
      ...args: ConstructorParameters<typeof WrapperContext>
    ) => BotContext,
  });
  bot.api.config.use(autoRetry());

  const authGuard = createAuthGuard(adminChatIds);

  bot.use(stream());
  bot.use(createLogMiddleware(config.onLog));

  // Build AI handler + runtime state (created before commands so state is available)
  let aiHandler: ReturnType<typeof createAiReplyHandler>["handler"] | undefined;
  let aiState: ReturnType<typeof createAiReplyHandler>["state"] | undefined;
  let aiSetModelForChat: ReturnType<typeof createAiReplyHandler>["setModelForChat"] | undefined;
  let aiGetModelForChat: ReturnType<typeof createAiReplyHandler>["getModelForChat"] | undefined;
  let aiResetModelForChat: ReturnType<typeof createAiReplyHandler>["resetModelForChat"] | undefined;
  let aiGetReplyMode: ReturnType<typeof createAiReplyHandler>["getReplyMode"] | undefined;
  let aiSetReplyMode: ReturnType<typeof createAiReplyHandler>["setReplyMode"] | undefined;
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
  let aiGetPixaiRateLimitStats:
    | ReturnType<typeof createAiReplyHandler>["getPixaiRateLimitStats"]
    | undefined;
  let aiDirectGenerate: ReturnType<typeof createAiReplyHandler>["directGenerate"] | undefined;
  let aiCanUseImageGeneration:
    | ReturnType<typeof createAiReplyHandler>["canUseImageGeneration"]
    | undefined;
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
      token,
    });
    aiHandler = result.handler;
    aiState = result.state;
    aiSetModelForChat = result.setModelForChat;
    aiGetModelForChat = result.getModelForChat;
    aiResetModelForChat = result.resetModelForChat;
    aiGetReplyMode = result.getReplyMode;
    aiSetReplyMode = result.setReplyMode;
    aiGetImageGenEnabled = result.getImageGenEnabled;
    aiSetImageGenEnabled = result.setImageGenEnabled;
    aiGetPixaiFullConfig = result.getPixaiFullConfig;
    aiUpdatePixaiConfig = result.updatePixaiConfig;
    aiGetPixaiRateLimitStats = result.getPixaiRateLimitStats;
    aiDirectGenerate = result.directGenerate;
    aiCanUseImageGeneration = result.canUseImageGeneration;
  }

  bot.command("start", startCommand);
  bot.command("help", helpCommand);
  bot.command("md2tg", md2tgCommand);
  bot.command("status", authGuard, createStatusCommand(statusConfig, aiState));
  bot.command("restart", authGuard, createRestartCommand(config.onRestart));
  bot.command("backup", authGuard, createBackupCommand(config.onBackup));
  bot.command("clear", createClearCommand(config.conversation, adminChatIds));
  bot.command(
    "clearreceived",
    authGuard,
    createClearReceivedCommand(config.aiReply?.dataFiles?.dataDir),
  );

  // Register /model command if models are configured
  if (config.aiReply?.models?.length && aiSetModelForChat && aiGetModelForChat) {
    const modelAccess = config.aiReply.modelCommandAccess ?? "admin";
    const modelCmd = createModelCommand({
      getModelForChat: aiGetModelForChat,
      setModelForChat: aiSetModelForChat,
      resetModelForChat: aiResetModelForChat,
      models: config.aiReply.models,
      defaultModel: config.aiReply.model,
    });
    if (modelAccess === "admin") {
      bot.command("model", authGuard, modelCmd);
    } else {
      bot.command("model", modelCmd);
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
      await callbackQueryHandler(ctx);
    });

    bot.on(["message:text", "message:photo", "message:document"], aiHandler);
  }

  bot.api.setMyCommands(commands).catch((err) => {
    const desc = err instanceof GrammyError ? err.description : String(err);
    logger.warn(`Failed to set commands: ${desc}`);
  });

  bot.catch((err) => {
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
    ctx.resolveWait(errorMsg, "Markdown");
  });

  return bot;
}

export { WrapperContext, type BotContext } from "./context.js";
export {
  assemblePromptPreview,
  type PromptPreviewInput,
  type PromptPreviewResult,
} from "./services/context-assembler.js";
export type { DataFilesConfig } from "./utils/data-files.js";
