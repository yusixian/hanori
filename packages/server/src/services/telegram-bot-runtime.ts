import type { AiGroupOverride, IBotManager } from "@cos-tool-bot/shared";
import type { TelegramMembershipVerifier } from "./mini-app-access-policy.js";

export interface TelegramBotPublicProfile {
  telegramUserId: number;
  username: string;
  displayName: string;
  observedAt: Date;
}

export interface TelegramBotRuntime {
  getTelegramProfile(): Promise<TelegramBotPublicProfile>;
  isTelegramMember(input: { chatId: number; userId: number }): Promise<boolean>;
  getTelegramBotMembership(input: {
    chatId: number;
  }): Promise<"creator" | "administrator" | "member" | "restricted" | "left" | "kicked">;
  applyTelegramGroupOverride(input: { chatId: number; override: AiGroupOverride }): void;
}

export interface BotManagerLookup {
  getManager(botId: string): IBotManager | undefined;
}

type TelegramChatMemberProjection =
  | { status: "creator" | "administrator" | "member" | "left" | "kicked" }
  | { status: "restricted"; is_member: boolean };

export function isTelegramUserId(value: number): boolean {
  return Number.isSafeInteger(value) && value > 0;
}

export function isTelegramGroupChatId(value: number): boolean {
  return Number.isSafeInteger(value) && value < 0;
}

export function mapTelegramMembership(member: TelegramChatMemberProjection): boolean {
  switch (member.status) {
    case "creator":
    case "administrator":
    case "member":
      return true;
    case "restricted":
      return member.is_member === true;
    case "left":
    case "kicked":
      return false;
    default:
      throw new Error("Unsupported Telegram chat member status");
  }
}

export function supportsTelegramBotRuntime(
  manager: IBotManager,
): manager is IBotManager & TelegramBotRuntime {
  const candidate = manager as Partial<TelegramBotRuntime>;
  return (
    typeof candidate.getTelegramProfile === "function" &&
    typeof candidate.isTelegramMember === "function" &&
    typeof candidate.getTelegramBotMembership === "function" &&
    typeof candidate.applyTelegramGroupOverride === "function"
  );
}

function requireBotId(botId: string): void {
  if (botId.trim().length === 0) throw new Error("Bot ID is required");
}

/**
 * A tenant-scoped adapter from BotPool's generic manager registry to the
 * Telegram-only capabilities needed by Mini App authorization and profile sync.
 */
export class BotPoolTelegramRuntimeAdapter implements TelegramMembershipVerifier {
  constructor(private readonly botPool: BotManagerLookup) {}

  async isMember(input: { botId: string; chatId: number; userId: number }): Promise<boolean> {
    requireBotId(input.botId);
    if (!isTelegramGroupChatId(input.chatId)) {
      throw new Error("Telegram group chat ID must be a negative safe integer");
    }
    if (!isTelegramUserId(input.userId)) {
      throw new Error("Telegram user ID must be a positive safe integer");
    }

    return this.getRunningTelegramManager(input.botId).isTelegramMember({
      chatId: input.chatId,
      userId: input.userId,
    });
  }

  async getProfile(botId: string): Promise<TelegramBotPublicProfile> {
    requireBotId(botId);
    return this.getRunningTelegramManager(botId).getTelegramProfile();
  }

  async getBotMembership(input: {
    botId: string;
    chatId: number;
  }): Promise<"creator" | "administrator" | "member" | "restricted" | "left" | "kicked"> {
    requireBotId(input.botId);
    if (!isTelegramGroupChatId(input.chatId)) {
      throw new Error("Telegram group chat ID must be a negative safe integer");
    }
    return this.getRunningTelegramManager(input.botId).getTelegramBotMembership({
      chatId: input.chatId,
    });
  }

  async applyGroupOverride(input: {
    botId: string;
    chatId: number;
    override: AiGroupOverride;
  }): Promise<void> {
    requireBotId(input.botId);
    if (!isTelegramGroupChatId(input.chatId) || input.override.chatId !== input.chatId) {
      throw new Error("Telegram group override scope is invalid");
    }
    this.getRunningTelegramManager(input.botId).applyTelegramGroupOverride({
      chatId: input.chatId,
      override: structuredClone(input.override),
    });
  }

  private getRunningTelegramManager(botId: string): IBotManager & TelegramBotRuntime {
    const manager = this.botPool.getManager(botId);
    if (!manager) throw new Error(`Bot ${botId} is not running`);
    if (manager.botId !== botId) {
      throw new Error(`Bot manager scope mismatch for ${botId}`);
    }
    if (manager.status !== "running") throw new Error(`Bot ${botId} is not running`);
    if (!supportsTelegramBotRuntime(manager)) {
      throw new Error(`Bot ${botId} does not support Telegram runtime operations`);
    }
    return manager;
  }
}
