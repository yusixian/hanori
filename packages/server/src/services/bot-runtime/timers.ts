import type { TimerCallbacks } from "@cos-tool-bot/bot";
import type { Logger } from "pino";
import type { TimerRegistry } from "../timer-registry.js";
import type { BotRuntimeHost } from "./types.js";

export function createTimerCallbacks(
  botId: string,
  registry: TimerRegistry,
  logger: Logger,
  host: BotRuntimeHost,
): TimerCallbacks {
  return {
    onTimerCreate: async (params) => {
      await registry.registerAi({
        timerId: params.timerId,
        botId,
        chatId: params.chatId,
        name: params.reason,
        seconds: params.seconds,
        meta: { reason: params.reason, userId: params.userId },
        handle: params.handle,
        onFire: (timerId, ownerBotId, chatId, meta, delayed) =>
          host.fireRecoveredTimer(timerId, ownerBotId, chatId, meta, delayed),
      });
    },
    onTimerCancel: (timerId) => {
      registry.cancel(timerId).catch((err) => {
        logger.error(err, `Failed to cancel timer ${timerId} in registry`);
      });
    },
    onTimerFired: async (timerId) => {
      await registry.markFired(timerId).catch((err) => {
        logger.error(err, `Failed to mark timer ${timerId} fired in registry`);
        throw err;
      });
    },
    onGetTimers: () => host.getActiveTimersForBot(botId),
    onCancelTimer: (timerId) => host.cancelTimerForBot(botId, timerId),
    onBotReady: (handlers) => {
      host.attachTimerHandlers(botId, handlers);
    },
  };
}
