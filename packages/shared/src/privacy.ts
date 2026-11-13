export type UserPrivacyMode = "normal" | "isolated" | "off";

/**
 * Whether unscoped (cross-chat) personal memories apply to the user. Isolated users keep personal
 * memories per chat, for recall and for new writes alike.
 */
export function includesUnscopedPersonalMemories(mode: UserPrivacyMode | undefined): boolean {
  return mode !== "isolated";
}

export interface UserPrivacyForgetResult {
  conversationMessages: number;
  profiles: number;
  personalMemories: number;
}

export class UserPrivacyBusyError extends Error {}

export interface UserPrivacyCallbacks {
  getMode(userId: number): Promise<UserPrivacyMode>;
  /** Durable quote-only boundary so old Telegram replies cannot bypass an off/forget after restart. */
  getQuoteResetAt?(userId: number): Promise<number | undefined>;
  /** Last off/forget boundary for invalidating captured context after re-enabling. */
  getContextResetAt?(userId: number): number | undefined;
  /**
   * Serializes personalization work for one Telegram user across chats.
   * Callers must use this around reads, writes, and privacy mutations.
   */
  runExclusive<T>(userId: number, operation: () => Promise<T>): Promise<T>;
  /** Reentrant multi-author operations, including tools within an existing user lock. */
  runExclusiveMany?<T>(
    userIds: readonly number[],
    operation: () => Promise<T>,
    options?: { waitIfBusy?: boolean },
  ): Promise<T>;
  setMode(userId: number, mode: UserPrivacyMode): Promise<void>;
  forget(userId: number): Promise<UserPrivacyForgetResult>;
}
