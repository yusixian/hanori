export type EngagementMode = "off" | "shadow" | "active";
export type EngagementStyle = "natural" | "assistant" | "filter";
export type EngagementChoice = "continue" | "join" | "silent";
export type EngagementLabel = "answer" | "silent" | "uncertain";

export interface EngagementPolicy {
  mode: EngagementMode;
  style: EngagementStyle;
  preferences: string;
  keywordDirect: boolean;
  cooldownSeconds: number;
  confidenceThreshold: number;
  addressedConfidenceThreshold: number;
  continueConfidenceThreshold: number;
  /** Zero disables the recent-conversation cooldown exemption. */
  continuationWindowSeconds: number;
  contextMessages: number;
  timeoutMs: number;
}
export const DEFAULT_ENGAGEMENT_POLICY: EngagementPolicy = {
  mode: "off",
  style: "natural",
  preferences: "",
  keywordDirect: false,
  cooldownSeconds: 60,
  confidenceThreshold: 0.8,
  addressedConfidenceThreshold: 0.8,
  continueConfidenceThreshold: 0.8,
  continuationWindowSeconds: 120,
  contextMessages: 20,
  timeoutMs: 1000,
};
export const ENGAGEMENT_MODEL = "jev-1.13.0";
export interface EngagementConfigStored extends EngagementPolicy {
  encryptedApiKey: string | null;
}
export interface EngagementConfigPublic extends EngagementPolicy {
  hasApiKey: boolean;
}
export interface EngagementConfigRuntime extends EngagementPolicy {
  apiKey?: string;
}
export interface EngagementContextMessage {
  messageId: number;
  userId: number;
  text: string;
  timestamp: number;
  isBot?: boolean;
  /** Contributors whose privacy settings govern this text; never sent as provider identities. */
  privacyUserIds?: number[];
  /** Earliest captured source, retained when a later assistant response derives from it. */
  privacyCapturedAt?: number;
}
export interface EngagementParticipationDecision {
  choice: "addressed" | "continue" | "join";
  confidence: number;
}
export interface EngagementSample {
  chatId: number;
  messageId: number;
  mode: EngagementMode;
  style: EngagementStyle;
  choice: EngagementChoice | null;
  /** High-confidence direct invitation; bypasses proactive cooldown, not reply/privacy gates. */
  addressed?: boolean;
  engagement: "answer" | "silent";
  confidence: number | null;
  /** Provider decision before local routing thresholds; absent in older samples. */
  participation?: EngagementParticipationDecision;
  /** Current samples store independent answer/silent and addressed/continue/join distributions.
   * Legacy samples have a single continue/join/silent distribution (no answer key).
   */
  probabilities: Record<string, number> | null;
  reasonCode: string;
  actualTrigger: string | null;
  model: string;
  configVersion: string;
  configSnapshot: EngagementPolicy;
  latencyMs: number;
  inputTokens: number | null;
  estimatedCostUsd: number | null;
  context: EngagementContextMessage[];
  errorCategory?: string;
}
