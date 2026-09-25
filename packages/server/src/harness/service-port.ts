import type { HarnessBotPort } from "@cos-tool-bot/bot";
import { handleHarnessCallback } from "./callbacks.js";
import { handleHarnessCommand } from "./commands.js";
import { handleOwnerReply } from "./protocol.js";
import { renderUsageHint } from "./render.js";
import type { HarnessService } from "./service.js";

export function createHarnessPort(service: HarnessService): HarnessBotPort {
  return {
    isHarnessChat: (chatId) => service.loadedConfig?.file.telegram.chatId === chatId,
    isOwner: (userId) => service.loadedConfig?.file.telegram.owners.includes(userId) ?? false,
    allowsCasualReplies: () =>
      service.loadedConfig ? service.globalView().config.telegram.chat.casualReplies : false,
    usageHint: (threadId, assistantReady) =>
      renderUsageHint(service.projectKeyForThread(threadId), assistantReady),
    onBotReady: (telegram) => {
      service.attachTelegram(telegram);
      void service
        .apply()
        .then(() => service.work.scheduler.start())
        .catch((error) =>
          service.logger.error(`Dev Harness apply failed: ${(error as Error).message}`),
        );
    },
    handleCommand: (request) => handleHarnessCommand(service, request),
    handleCallback: (request) => handleHarnessCallback(service, request),
    handleReply: (request) => handleOwnerReply(service.work, request),
    handleTopicMessage: (request, runtime) => service.assistant.handleMessage(request, runtime),
  };
}
