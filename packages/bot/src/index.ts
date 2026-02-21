import type { BotLogEntry, ConversationCallbacks } from "@cos-tool-bot/shared";
import { Bot, GrammyError, HttpError } from "grammy";
import type { Logger } from "pino";
import { createClearCommand } from "./commands/clear.js";
import { commands, helpCommand } from "./commands/help.js";
import { md2tgCommand } from "./commands/md2tg.js";
import { createRestartCommand } from "./commands/restart.js";
import { startCommand } from "./commands/start.js";
import { WrapperContext } from "./context.js";
import { createAuthGuard } from "./guards/auth.js";
import { type AiReplyConfig, createAiReplyHandler } from "./handlers/ai-reply.js";
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

  bot.command("start", startCommand);
  bot.command("help", helpCommand);
  bot.command("md2tg", md2tgCommand);
  bot.command("restart", authGuard, createRestartCommand(config.onRestart));
  bot.command("clear", authGuard, createClearCommand(config.conversation));

  if (config.aiReply) {
    bot.on(
      "message:text",
      createAiReplyHandler({
        ...config.aiReply,
        adminChatIds,
        onLog: config.onLog,
      }),
    );
  }

  bot.api.setMyCommands([
    ...commands,
    { command: "clear", description: "清除当前对话历史 (Admin)" },
  ]);

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
