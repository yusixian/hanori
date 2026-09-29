export interface TokenUsageRecord {
  chatId: number;
  userId?: number;
  model: string;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  /** Undefined means the provider did not report cache-read usage. */
  cacheReadTokens?: number;
  /** Undefined means the provider did not report cache-write usage. */
  cacheWriteTokens?: number;
  providerId?: string;
  staticPrefixHash?: string;
  toolSchemaHash?: string;
  cacheFingerprint?: string;
  durationMs?: number;
  trigger?: string;
}
