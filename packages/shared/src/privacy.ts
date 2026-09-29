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

export interface UserPrivacyCallbacks {
  getMode(userId: number): Promise<UserPrivacyMode>;
  /** Last off/forget boundary for invalidating captured context after re-enabling. */
  getContextResetAt?(userId: number): number | undefined;
  /**
   * Serializes personalization work for one Telegram user across chats.
   * Callers must use this around reads, writes, and privacy mutations.
   */
  runExclusive<T>(userId: number, operation: () => Promise<T>): Promise<T>;
  setMode(userId: number, mode: UserPrivacyMode): Promise<void>;
  forget(userId: number): Promise<UserPrivacyForgetResult>;
}
