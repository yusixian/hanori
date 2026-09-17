import type { AiGroupOverride } from "@cos-tool-bot/shared";

export interface AiChatAccessConfig {
  groupOverrides: Record<string, AiGroupOverride>;
  privateChatAccess?: "all" | "admin" | "allowlist";
  privateChatWhitelist?: number[];
}

export function canAccessAiChat(
  config: AiChatAccessConfig,
  input: {
    chatId: number;
    userId: number;
    isPrivate: boolean;
    isBotAdmin: boolean;
  },
): boolean {
  if (input.isPrivate) {
    const access = config.privateChatAccess ?? "all";
    return (
      access === "all" ||
      input.isBotAdmin ||
      (access === "allowlist" && config.privateChatWhitelist?.includes(input.userId) === true)
    );
  }

  const override = config.groupOverrides[String(input.chatId)];
  return (override?.enabled ?? true) && ((override?.whitelisted ?? false) || input.isBotAdmin);
}
