import type { Api } from "grammy";
import { createArtworkTools, type ArtworkToolsOptions } from "./artwork/index.js";
import { createBehaviorTools, type BehaviorToolsOptions } from "./behavior.js";
import { createTelegramTools, type TelegramToolsOptions } from "./telegram.js";
import type { OnceGuardContext } from "./utils.js";

type TurnInteractionCommonOptions = {
  api: Api;
  chatId: number;
  recentBotMessageIds: number[];
  onceGuard: OnceGuardContext;
};

export interface TurnInteractionToolsOptions extends TurnInteractionCommonOptions {
  telegram: Omit<TelegramToolsOptions, "api" | "chatId" | "recentBotMessageIds" | "onceGuard">;
  behavior: Omit<BehaviorToolsOptions, "api" | "chatId" | "recentBotMessageIds">;
  artwork?: Pick<ArtworkToolsOptions, "config" | "timeoutConfig" | "unifiedSearchEnabled">;
}

export function createTurnInteractionTools(options: TurnInteractionToolsOptions) {
  const { api, chatId, recentBotMessageIds, onceGuard } = options;
  const telegramTools = createTelegramTools({
    ...options.telegram,
    api,
    chatId,
    recentBotMessageIds,
    onceGuard,
  });
  const behaviorTools = createBehaviorTools({
    ...options.behavior,
    api,
    chatId,
    recentBotMessageIds,
  });
  const artworkTools = options.artwork?.config.enabled
    ? createArtworkTools({
        api,
        chatId,
        recentBotMessageIds,
        onceGuard,
        ...options.artwork,
      })
    : {};

  return { telegramTools, behaviorTools, artworkTools };
}
