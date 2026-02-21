import type { BotLogEntry, ConversationCallbacks } from "@cos-tool-bot/shared";
import { DEFAULT_CONVERSATION_CONFIG, DEFAULT_MEMORY_CONFIG } from "@cos-tool-bot/shared";
import { Bot, GrammyError, HttpError } from "grammy";
import type { Logger } from "pino";
import { createClearCommand } from "./commands/clear.js";
import { commands, helpCommand } from "./commands/help.js";
import { md2tgCommand } from "./commands/md2tg.js";
import { createRestartCommand } from "./commands/restart.js";
import { startCommand } from "./commands/start.js";
import { createStatusCommand } from "./commands/status.js";
import { WrapperContext } from "./context.js";
import { createAuthGuard } from "./guards/auth.js";
import { type AiReplyConfig, createAiReplyHandler } from "./handlers/ai-reply.js";
import { createPollAnswerHandler, createCallbackQueryHandler } from "./handlers/event-handlers.js";
import { createLogMiddleware } from "./middleware/log.js";

export type AiReplyBotConfig = Omit<AiReplyConfig, "adminChatIds" | "onLog">;

export interface BotConfig {
  token: string;
  adminChatIds: number[];
  logger: Logger;
  onRestart?: () => void | Promise<void>;
  onLog?: (entry: BotLogEntry) => void | Promise<void>;
  aiReply?: AiReplyBotConfig;
  conversation?: ConversationCallbacks;
}

export function createBot(config: BotConfig) {
  const { token, adminChatIds, logger } = config;

  const bot = new Bot<WrapperContext>(token, {
    ContextConstructor: WrapperContext,
  });

  const authGuard = createAuthGuard(adminChatIds);

  bot.use(createLogMiddleware(config.onLog));

  // Build AI handler + runtime state (created before commands so state is available)
  let aiHandler: ReturnType<typeof createAiReplyHandler>["handler"] | undefined;
  let aiState: ReturnType<typeof createAiReplyHandler>["state"] | undefined;
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
    });
    aiHandler = result.handler;
    aiState = result.state;
  }

  bot.command("start", startCommand);
  bot.command("help", helpCommand);
  bot.command("md2tg", md2tgCommand);
  bot.command("status", authGuard, createStatusCommand(statusConfig, aiState));
  bot.command("restart", authGuard, createRestartCommand(config.onRestart));
  bot.command("clear", createClearCommand(config.conversation, adminChatIds));

  if (aiHandler && aiState) {
    // Register event handlers for interactive tools (polls, choices)
    const pendingActions = aiState.getPendingActions();

    const pollAnswerHandler = createPollAnswerHandler({
      api: bot.api,
      pendingActions,
      getContinueChatConfig: () => aiState!.getContinueChatConfig(),
      isPrivateChat: (chatId) => aiState!.isPrivateChat(chatId),
    });

    const callbackQueryHandler = createCallbackQueryHandler({
      api: bot.api,
      pendingActions,
      getContinueChatConfig: () => aiState!.getContinueChatConfig(),
    });

    bot.on("poll_answer", async (ctx) => {
      await pollAnswerHandler(ctx.pollAnswer);
    });

    bot.on("callback_query:data", async (ctx) => {
      await callbackQueryHandler(ctx);
    });

    bot.on("message:text", aiHandler);
  }

  bot.api.setMyCommands(commands);

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

export { WrapperContext } from "./context.js";
