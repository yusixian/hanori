import {
  getMiniAppCapabilities,
  type MiniAppCapability,
  type MiniAppRole,
} from "@cos-tool-bot/shared";

export interface TelegramMembershipVerifier {
  isMember(input: { botId: string; chatId: number; userId: number }): Promise<boolean>;
}

export type MiniAppChatScope =
  | { kind: "all" }
  | { kind: "granted"; chatIds: readonly number[] }
  | { kind: "none" };

export interface MiniAppAccessDecision {
  role: MiniAppRole;
  capabilities: readonly MiniAppCapability[];
  chatScope: MiniAppChatScope;
}

export interface ResolveMiniAppAccessInput {
  botId: string;
  telegramUserId: number;
  adminTelegramUserIds: readonly number[];
  operatorTelegramUserIds: readonly number[];
  grantedChatIds: readonly number[];
  membershipVerifier: TelegramMembershipVerifier;
}

function validUserIds(ids: readonly number[]): Set<number> {
  return new Set(ids.filter((id) => Number.isSafeInteger(id) && id > 0));
}

function validChatIds(ids: readonly number[]): number[] {
  return [...new Set(ids.filter((id) => Number.isSafeInteger(id) && id < 0))];
}

function decision(role: MiniAppRole, chatScope: MiniAppChatScope): MiniAppAccessDecision {
  return { role, capabilities: getMiniAppCapabilities(role), chatScope };
}

/**
 * Resolves current grants on every call. It deliberately owns no grant or
 * membership cache so revocation is visible to the next authorization check.
 */
export class MiniAppAccessPolicy {
  async resolve(input: ResolveMiniAppAccessInput): Promise<MiniAppAccessDecision> {
    if (!Number.isSafeInteger(input.telegramUserId) || input.telegramUserId <= 0) {
      return decision("none", { kind: "none" });
    }

    if (validUserIds(input.adminTelegramUserIds).has(input.telegramUserId)) {
      return decision("admin", { kind: "all" });
    }

    const grantedChatIds = validChatIds(input.grantedChatIds);
    if (validUserIds(input.operatorTelegramUserIds).has(input.telegramUserId)) {
      return decision("operator", { kind: "granted", chatIds: grantedChatIds });
    }

    const memberChatIds: number[] = [];
    for (const chatId of grantedChatIds) {
      try {
        if (
          await input.membershipVerifier.isMember({
            botId: input.botId,
            chatId,
            userId: input.telegramUserId,
          })
        ) {
          memberChatIds.push(chatId);
        }
      } catch {
        // Telegram/API uncertainty must not create viewer access.
      }
    }

    return memberChatIds.length > 0
      ? decision("viewer", { kind: "granted", chatIds: memberChatIds })
      : decision("none", { kind: "none" });
  }
}
