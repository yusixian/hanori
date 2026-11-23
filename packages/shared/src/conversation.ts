import type { QuoteSource } from "./quote.js";
export interface ConversationConfig {
  enabled: boolean;
  maxContextMessages: number;
  groupHistoryMaxTokens: number;
  historyFormat?: "prompt" | "messages";
  groupBufferSize: number;
  groupContextMode: "all" | "random_only" | "none";
  /** @deprecated Group messages are now persisted individually whenever group history is enabled. */
  saveGroupContext: "random_only" | "all" | "none";
  autoSummarize: boolean;
  summarizeThreshold: number;
  /** Provider used for conversation compression. Missing values inherit the active Provider. */
  compressionProviderId?: string;
  retentionDays: number;
  maxRawMessagesPerChat: number;
}

export const DEFAULT_CONVERSATION_CONFIG: ConversationConfig = {
  enabled: true,
  maxContextMessages: 20,
  groupHistoryMaxTokens: 12_000,
  historyFormat: "prompt",
  groupBufferSize: 50,
  groupContextMode: "all",
  saveGroupContext: "random_only",
  autoSummarize: true,
  summarizeThreshold: 30,
  retentionDays: 30,
  maxRawMessagesPerChat: 50_000,
};

export type ConversationRole =
  | "user"
  | "assistant"
  | "context"
  | "system"
  | "tool_call"
  | "tool_result";

export type ConversationForwardOrigin =
  | { type: "user"; name: string; username?: string }
  | { type: "hidden_user"; name: string }
  | {
      type: "chat" | "channel";
      name: string;
      username?: string;
      authorSignature?: string;
    };

export interface ConversationRelayOrigin {
  source: "cosinside";
  initiatorTelegramId: number;
  initiatorName: string;
}

export interface ConversationHistoryBudgetTrace {
  configuredTokens: number;
  usedTokens: number;
  completeRawHistory: boolean;
  usedSummary: boolean;
  rawMessageCount: number;
  earliestMessageId: number | null;
  latestMessageId: number | null;
  degraded: boolean;
  compressionRecommended?: boolean;
  compressionAttempted?: boolean;
}

export interface RecentCrossChatUserMessage {
  id: number;
  content: string;
  createdAt: string;
}

export interface ConversationCallbacks {
  findOwnMessage?(chatId: number, messageId: number): Promise<boolean>;
  updateOwnMessage?(chatId: number, messageId: number, content: string): Promise<void>;
  getHistory(
    chatId: number,
    limit: number,
    tokenBudget?: number,
    options?: {
      excludeSourceKey?: string;
      beforeId?: number;
      beforeTelegramMessageId?: number;
      /** When supplied, restrict history to this forum topic (null means non-topic messages). */
      threadId?: number | null;
    },
  ): Promise<{
    summary: string | null;
    messages: Array<{
      id?: number;
      role: string;
      content: string;
      userName: string | null;
      forwardOrigin?: ConversationForwardOrigin;
      relayOrigin?: ConversationRelayOrigin;
      createdAt?: string;
      /** Telegram message ID, present for messages the bot ingested from a chat. */
      tgMessageId?: number;
      quoteSource?: QuoteSource;
    }>;
    budgetTrace?: ConversationHistoryBudgetTrace;
  }>;
  getRecentUserMessagesAcrossChats?(
    userId: number,
    excludeChatId: number,
    limit: number,
    beforeId?: number,
  ): Promise<RecentCrossChatUserMessage[]>;
  /** Global history watermark captured when a request is admitted, not when it runs. */
  getHistoryWatermark?(): Promise<number | undefined>;
  addMessage(params: {
    chatId: number;
    role: ConversationRole;
    content: string;
    userAuthoredContent?: string;
    userId?: number;
    userName?: string;
    sourceKey?: string;
    meta?: Record<string, unknown>;
  }): Promise<void>;
  addMessages(
    messages: Array<{
      chatId: number;
      role: ConversationRole;
      content: string;
      userAuthoredContent?: string;
      userId?: number;
      userName?: string;
      sourceKey?: string;
      meta?: Record<string, unknown>;
    }>,
  ): Promise<void>;
  upsertUserMessage?(params: {
    chatId: number;
    content: string;
    userAuthoredContent?: string;
    userId: number;
    userName?: string;
    sourceKey: string;
    meta?: Record<string, unknown>;
  }): Promise<{ id: number } | void>;
  completeTurn?(chatId: number, sourceKey: string, turnOrderId?: number): Promise<void>;
  completeTurns?(
    chatId: number,
    sourceKeys: readonly string[],
    turnOrderId?: number,
  ): Promise<void>;
  ensureCompression?(chatId: number): Promise<void>;
  triggerCompression(chatId: number): void | Promise<void>;
  clearHistory(chatId: number): Promise<void>;
}
