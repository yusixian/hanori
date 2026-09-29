import type {
  EngagementConfigStored,
  EngagementConfigPublic,
  EngagementPolicy,
} from "./engagement.js";
// Image generation size constraints (single source of truth)
export const IMAGE_MIN_SIZE = 1;
export const IMAGE_MAX_SIZE = 3072;

// AI Reply types

export type ModelCapability =
  | "vision"
  | "tool_calling"
  | "web_search"
  | "reasoning"
  | "long_context"
  | "code";

export interface ModelEntry {
  id: string;
  label?: string;
  capabilities?: ModelCapability[];
  temperature?: number;
  maxTokens?: number;
  thinking?: "enabled" | "disabled";
  thinkingBudget?: number;
}

/** Runtime model configuration passed to the isolated coding worker for one tool call. */
export interface GitHubCodingModelConfig {
  apiKey: string;
  baseURL: string;
  id: string;
  providerFormat: "openai" | "gemini";
  maxTokens?: number;
  capabilities: ModelCapability[];
  thinking?: ModelEntry["thinking"];
}

// Memory system types
export interface MemoryConfig {
  enabled: boolean;
  maxSteps: number;
  autoReadProfile: boolean;
  autoUpdateLastSeen: boolean;
  toolChoice: "auto" | "required";
}

export interface DataFilesInjectionConfig {
  injectableFiles: string[];
  maxTotalSize: number;
}

export const DEFAULT_INJECTABLE_FILES = ["IDENTITY.md", "SOUL.md"];
export const DEFAULT_MAX_INJECTION_SIZE = 256 * 1024;
export const DEFAULT_AI_MAX_STEPS = 128;
export const MAX_TOOL_CALLS_PER_REQUEST = 512;
export const DEFAULT_SUB_AGENT_MAX_STEPS = 64;
export const MAX_SUB_AGENT_STEPS = 128;
export const MAX_CONCURRENT_AI_REPLIES = 128;

export const DEFAULT_MEMORY_CONFIG: MemoryConfig = {
  enabled: false,
  maxSteps: DEFAULT_AI_MAX_STEPS,
  autoReadProfile: true,
  autoUpdateLastSeen: true,
  toolChoice: "auto",
};

export interface PeopleProfile {
  telegramId: number;
  username: string | null;
  displayName: string | null;
  firstName: string | null;
  lastName: string | null;
  languageCode: string | null;
  isPremium: boolean;
  hasAvatar: boolean;
  avatarVersion: string | null;
  notes: string | null;
  traits: string[];
  interests: string[];
  relationship: string | null;
  firstSeen: string;
  lastSeen: string;
}

export interface PeopleProfileObservation {
  telegramId: number;
  username: string | null;
  displayName: string;
  firstName: string;
  lastName: string | null;
  languageCode: string | null;
  isPremium: boolean;
}

export interface PeopleProfileAvatarUpdate {
  telegramId: number;
  profileId: number;
  refreshVersion: number;
  avatarPath: string | null;
  avatarVersion: string | null;
}

export interface PeopleProfileAvatarRefresh {
  telegramId: number;
  profileId: number;
}

export interface PeopleProfileAvatarUpdateResult {
  previousAvatarPath: string | null;
}

export type PeopleProfileAvatarMediaType = "image/jpeg" | "image/png" | "image/webp";

export type PeopleProfileAvatarResult =
  | {
      status: "available";
      telegramId: number;
      avatarVersion: string | null;
      mediaType: PeopleProfileAvatarMediaType;
      data: Uint8Array;
    }
  | {
      status: "not_found" | "no_avatar" | "cache_unavailable" | "forbidden" | "unavailable";
    };

export interface PeopleProfileTouchResult {
  created: boolean;
  profileId: number;
}

export interface MemorySearchResult {
  role: string;
  content: string;
  userName: string | null;
  chatId: number;
  createdAt: string;
}

export interface MemoryCallbacks {
  getProfile(telegramId: number): Promise<PeopleProfile | null>;
  getProfileAvatar?(
    telegramId: number,
    requesterTelegramId: number,
  ): Promise<PeopleProfileAvatarResult>;
  upsertProfile(data: {
    telegramId: number;
    username?: string;
    displayName?: string;
    notes?: string;
    traits?: string[];
    interests?: string[];
    relationship?: string;
  }): Promise<PeopleProfile>;
  searchProfiles(query: string): Promise<PeopleProfile[]>;
  searchHistory(params: {
    query: string;
    chatId?: number;
    userId?: number;
    limit?: number;
  }): Promise<MemorySearchResult[]>;
  touchProfile(observation: PeopleProfileObservation): Promise<PeopleProfileTouchResult>;
  beginProfileAvatarRefresh(refresh: PeopleProfileAvatarRefresh): Promise<number | null>;
  updateProfileAvatar(
    update: PeopleProfileAvatarUpdate,
  ): Promise<PeopleProfileAvatarUpdateResult | null>;
}

export interface TimeoutConfig {
  /** 主 AI generateText 总超时 (ms) */
  aiReplyMs?: number;
  /** 每个 AI step（单轮 API 调用）超时 (ms) */
  perStepMs?: number;
  /** 搜索请求超时 (ms) */
  searchMs?: number;
  /** 网页抓取超时 (ms) */
  fetchPageMs?: number;
  /** 图片生成超时 (ms) */
  imageGenerationMs?: number;
  /** researcher agent 超时 (ms) */
  researcherAgentMs?: number;
  /** 其他 agent 超时 (ms) */
  defaultAgentMs?: number;
  /** 图片下载超时 (ms) */
  imageDownloadMs?: number;
  /** PixAI 后台任务轮询超时 (ms) */
  pixaiTaskMs?: number;
}

export const DEFAULT_TIMEOUT_CONFIG: Required<TimeoutConfig> = {
  aiReplyMs: 60 * 60 * 1000,
  perStepMs: 5 * 60 * 1000,
  searchMs: 2 * 60 * 1000,
  fetchPageMs: 2 * 60 * 1000,
  imageGenerationMs: 60 * 60 * 1000,
  researcherAgentMs: 30 * 60 * 1000,
  defaultAgentMs: 30 * 60 * 1000,
  imageDownloadMs: 5 * 60 * 1000,
  pixaiTaskMs: 6 * 60 * 60 * 1000,
};

/** Keeps PixAI polling below the bounded pending-insert fallback retention window. */
export const PIXAI_TASK_TIMEOUT_MAX_MS = 23 * 60 * 60 * 1000;

export interface AiTriggerConfig {
  replyToBot: boolean;
  mentionBot: boolean;
  triggerWords: string[];
  randomReplyPercent: number;
  randomReplyCooldown: number;
}

export interface AiGroupOverride {
  engagement?: Partial<EngagementPolicy>;
  chatId: number;
  chatTitle?: string;
  enabled?: boolean;
  whitelisted: boolean;
  systemPrompt?: string;
  triggerConfig?: Partial<AiTriggerConfig>;
  conversationEnabled?: boolean;
  maxContextMessages?: number;
  groupHistoryMaxTokens?: number;
  imageGenerationEnabled?: boolean;
  /** Controls whether safe Provider/model labels are exposed in the Mini App. */
  aiSelectionDisplay?: "inherit" | "show" | "hide";
}

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

export type UserPrivacyMode = "normal" | "isolated" | "off";

/**
 * Whether unscoped (cross-chat) personal memories apply to the user. Isolated users keep personal
 * memories per chat, for recall and for new writes alike.
 */
export function includesUnscopedPersonalMemories(mode: UserPrivacyMode | undefined): boolean {
  return mode !== "isolated";
}

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
  getHistory(
    chatId: number,
    limit: number,
    tokenBudget?: number,
    options?: {
      excludeSourceKey?: string;
      beforeId?: number;
      beforeTelegramMessageId?: number;
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

export interface PixAIRateLimitConfig {
  maxConcurrentTasks?: number; // 全局并发上限，默认 6
  maxQueueDepth?: number; // 排队深度，默认 10
  userCooldownSec?: number; // 用户冷却秒数，默认 10
  chatCooldownSec?: number; // 群聊冷却秒数，默认 5
  hourlyLimit?: number; // 每小时限额（非管理员），默认 100
  adminBypass?: boolean; // 管理员绕过，默认 true
}

export const DEFAULT_PIXAI_RATE_LIMIT: Required<PixAIRateLimitConfig> = {
  maxConcurrentTasks: 6,
  maxQueueDepth: 10,
  userCooldownSec: 10,
  chatCooldownSec: 5,
  hourlyLimit: 100,
  adminBypass: true,
};

export interface PixAIConfig {
  // 限流配置
  rateLimit?: PixAIRateLimitConfig;

  // 基本参数
  negativePrompts?: string;
  samplingSteps?: number; // default 20, range 8-50
  cfgScale?: number; // default 5, range 1.1-15
  width?: number; // default 832, range IMAGE_MIN_SIZE-IMAGE_MAX_SIZE
  height?: number; // default 1472, range IMAGE_MIN_SIZE-IMAGE_MAX_SIZE
  batchSize?: number; // default 1, range 1-4
  promptHelper?: boolean; // default false (额外扣费)

  // 系统生图提示词（附加在每次生图 prompt 前面）
  systemImagePrompt?: string;

  // API 模式
  apiMode?: "graphql" | "rest"; // 默认 "graphql"

  // 通用参数
  priority?: number; // 默认 1000
  seed?: string; // 空字符串=随机
  clipSkip?: number; // 默认 2
  lightning?: boolean; // 快速模式

  // 模型相关
  modelStyle?: { type: "key"; keyId: string };
  inferenceProfile?: string; // 如 "standard"
  samplingMethod?: string; // 如 "Euler"
  qualityTag?: { prefix: string; suffix: string };

  // 高级
  isPrivate?: boolean;

  // NSFW 检测
  nsfwThreshold?: number; // NSFW 综合分数阈值，默认 0.5
}

export interface ImageGenerationReceiptConfig {
  /** Maximum UTF-16 units of the Prompt shown in a Telegram image caption. */
  promptPreviewLength?: number;
  truncationNoticeEnabled?: boolean;
  truncationNoticeText?: string;
  albumNoticeEnabled?: boolean;
  albumNoticeText?: string;
}

export const IMAGE_GENERATION_PROMPT_PREVIEW_MAX_LENGTH = 800;
export const IMAGE_GENERATION_RECEIPT_TEXT_MAX_LENGTH = 200;

export const DEFAULT_IMAGE_GENERATION_RECEIPT_CONFIG: Required<ImageGenerationReceiptConfig> = {
  promptPreviewLength: 200,
  truncationNoticeEnabled: true,
  truncationNoticeText: "⚠️ Prompt 已截断，完整内容见任务详情。",
  albumNoticeEnabled: true,
  albumNoticeText: "🔎 完整 Prompt、生成参数与任务进度",
};

export function resolveImageGenerationReceiptConfig(
  config?: ImageGenerationReceiptConfig,
): Required<ImageGenerationReceiptConfig> {
  const previewLength = config?.promptPreviewLength;
  return {
    promptPreviewLength:
      Number.isInteger(previewLength) && previewLength !== undefined
        ? Math.min(Math.max(previewLength, 0), IMAGE_GENERATION_PROMPT_PREVIEW_MAX_LENGTH)
        : DEFAULT_IMAGE_GENERATION_RECEIPT_CONFIG.promptPreviewLength,
    truncationNoticeEnabled:
      config?.truncationNoticeEnabled ??
      DEFAULT_IMAGE_GENERATION_RECEIPT_CONFIG.truncationNoticeEnabled,
    truncationNoticeText: normalizeImageGenerationReceiptText(
      config?.truncationNoticeText,
      DEFAULT_IMAGE_GENERATION_RECEIPT_CONFIG.truncationNoticeText,
    ),
    albumNoticeEnabled:
      config?.albumNoticeEnabled ?? DEFAULT_IMAGE_GENERATION_RECEIPT_CONFIG.albumNoticeEnabled,
    albumNoticeText: normalizeImageGenerationReceiptText(
      config?.albumNoticeText,
      DEFAULT_IMAGE_GENERATION_RECEIPT_CONFIG.albumNoticeText,
    ),
  };
}

function normalizeImageGenerationReceiptText(value: string | undefined, fallback: string): string {
  const normalized = value?.trim().replace(/[\r\n]+/g, " ") || fallback;
  let result = "";
  for (const character of normalized) {
    if (result.length + character.length > IMAGE_GENERATION_RECEIPT_TEXT_MAX_LENGTH) break;
    result += character;
  }
  return result;
}

export interface WebToolsConfig {
  enabled: boolean;
  /** Explicit hostnames/IPs that fetch_webpage may access on private networks. */
  trustedPrivateHosts?: string[];
  search?: {
    provider: "tavily" | "searxng" | "brave" | "custom";
    apiKey?: string;
    baseURL?: string;
  };
  imageGeneration?: {
    provider: "openai" | "custom" | "pixai";
    apiKey?: string;
    baseURL?: string;
    model?: string;
    size?: string;
    pixaiConfig?: PixAIConfig;
  };
}

export interface WebToolsConfigPublic {
  enabled: boolean;
  trustedPrivateHosts?: string[];
  search?: {
    provider: "tavily" | "searxng" | "brave" | "custom";
    hasApiKey?: boolean;
    baseURL?: string;
  };
  imageGeneration?: {
    provider: "openai" | "custom" | "pixai";
    hasApiKey?: boolean;
    baseURL?: string;
    model?: string;
    size?: string;
    pixaiConfig?: PixAIConfig;
  };
}

export interface AgentToolsConfig {
  enabled: boolean;
  subAgentModel?: string;
  maxSubAgentSteps?: number;
  agents?: Record<
    string,
    {
      enabled?: boolean;
      systemPrompt?: string;
    }
  >;
}

export interface ArtworkToolsConfig {
  enabled: boolean;
  pixivCookie?: string;
}

export const DEFAULT_ARTWORK_TOOLS_CONFIG: ArtworkToolsConfig = {
  enabled: false,
};

// Bot Memory types
export type BotMemoryKind = "fact" | "preference" | "event" | "commitment" | "relationship";

export interface BotMemory {
  id: number;
  botId: string;
  telegramId: number | null;
  content: string;
  category: string | null;
  kind: BotMemoryKind | null;
  scopeChatId: number | null;
  origin: string | null;
  sourceChatId: number | null;
  sourceMessageId: number | null;
  sourceUserId: number | null;
  expiresAt: string | null;
  factValidAt: string | null;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface BotMemoryConfig {
  enabled: boolean;
  maxMemories: number;
  autoInjectMemories: boolean;
}

export const DEFAULT_BOT_MEMORY_CONFIG: BotMemoryConfig = {
  enabled: false,
  maxMemories: 20,
  autoInjectMemories: true,
};

export type ReplyMode = "stream" | "segment";

export interface MessageConfig {
  replyMode?: ReplyMode; // "stream" = streaming draft, "segment" = multi_message tool
  richMessageEnabled?: boolean; // Telegram native Rich Messages, defaults to true
  autoSplitThreshold: number; // 0 = disabled, >0 = auto-split when text exceeds this character count
  splitDelayMs: number; // delay between split segments (ms), shows typing status
}

export const DEFAULT_MESSAGE_CONFIG: MessageConfig = {
  replyMode: "segment", // segment mode: multi_message tool + auto-split
  richMessageEnabled: true,
  autoSplitThreshold: 0, // disabled by default
  splitDelayMs: 800,
};

export const DEFAULT_TIMER_MAX_SECONDS = 86_400;
export const MIN_TIMER_MAX_SECONDS = 300;
/** TimerRegistry schedules every timer with one setTimeout, on creation and on restart
 *  recovery. A week keeps both delays far below the 2^31-1 ms overflow point, above which
 *  Node fires the timer immediately. */
export const MAX_TIMER_MAX_SECONDS = 604_800;

/** Resolve the effective set_timer ceiling, clamping stored values into the supported range. */
export function resolveTimerMaxSeconds(seconds?: number): number {
  if (seconds === undefined || !Number.isFinite(seconds)) return DEFAULT_TIMER_MAX_SECONDS;
  return Math.min(Math.max(Math.trunc(seconds), MIN_TIMER_MAX_SECONDS), MAX_TIMER_MAX_SECONDS);
}

export interface AiExecutionConfig {
  /** Maximum number of AI replies that may execute concurrently across chats for one Bot. */
  maxConcurrentReplies: number;
  /** Longest duration the AI may request from set_timer, in seconds. */
  timerMaxSeconds?: number;
  queueNotice: {
    enabled: boolean;
    /** Plain-text notice sent when an AI reply must wait for a scheduler slot. */
    text: string;
  };
}

export const DEFAULT_AI_EXECUTION_CONFIG: AiExecutionConfig = {
  maxConcurrentReplies: 32,
  timerMaxSeconds: DEFAULT_TIMER_MAX_SECONDS,
  queueNotice: {
    enabled: true,
    text: "正在处理中，请稍候～",
  },
};

export function isStreamReplyMode(config?: MessageConfig): boolean {
  return (config?.replyMode ?? DEFAULT_MESSAGE_CONFIG.replyMode) === "stream";
}

export function isRichMessageEnabled(config?: MessageConfig): boolean {
  return config?.richMessageEnabled ?? DEFAULT_MESSAGE_CONFIG.richMessageEnabled ?? true;
}

export interface EmbeddingConfig {
  enabled: boolean;
  encryptedApiKey: string;
  baseURL: string;
  model: string;
  dimensions: number;
}

export const DEFAULT_EMBEDDING_CONFIG: EmbeddingConfig = {
  enabled: false,
  encryptedApiKey: "",
  baseURL: "https://api.openai.com/v1",
  model: "gemini-embedding-2",
  dimensions: 3072,
};

export interface BotMemoryCallbacks {
  saveMemory(params: {
    content: string;
    category?: string;
    telegramId?: number;
    kind?: BotMemoryKind;
    scopeChatId?: number;
    origin?: string;
    sourceChatId?: number;
    sourceMessageId?: number;
    sourceUserId?: number;
    expiresAt?: string;
    factValidAt?: string;
  }): Promise<BotMemory>;
  recallMemories(params: {
    query?: string;
    category?: string;
    telegramId?: number;
    scopeChatId?: number;
    includeUnscopedPersonal?: boolean;
    scope?: "general_only" | "user_only" | "all";
    limit?: number;
  }): Promise<BotMemory[]>;
  updateMemory(
    memoryId: number,
    data: {
      content?: string;
      expectedContent?: string;
      category?: string | null;
      kind?: BotMemoryKind | null;
      expiresAt?: string | null;
      factValidAt?: string | null;
    },
    access: BotMemoryAccess,
  ): Promise<BotMemory | null>;
  retireMemory(
    memoryId: number,
    supersededById: number | undefined,
    access: BotMemoryAccess,
    expectedContent: string,
  ): Promise<boolean>;
  deleteMemory(memoryId: number, access: BotMemoryAccess): Promise<boolean>;
  getMemoriesForPrompt(
    telegramId?: number,
    limit?: number,
    scopeChatId?: number,
    includeUnscopedPersonal?: boolean,
  ): Promise<BotMemory[]>;
  getMemoriesForQuery?(params: {
    query?: string;
    telegramId?: number;
    scopeChatId?: number;
    includeUnscopedPersonal?: boolean;
    limit?: number;
  }): Promise<BotMemory[]>;
  searchProfiles?(query: string, telegramId?: number): Promise<PeopleProfile[]>;
}

export interface BotMemoryAccess {
  userId?: number;
  chatId: number;
  includeUnscopedPersonal?: boolean;
}

export interface AiProviderEntry {
  id: string;
  label: string;
  encryptedApiKey: string | null;
  baseURL: string;
  /** Relative model discovery path. Undefined preserves the legacy `/models` behavior. */
  modelDiscoveryPath?: string;
  providerFormat: "openai" | "gemini";
  defaultModel: string;
  models?: ModelEntry[];
}

export interface AiProviderEntryPublic {
  id: string;
  label: string;
  hasApiKey: boolean;
  baseURL: string;
  /** Relative model discovery path. Undefined preserves the legacy `/models` behavior. */
  modelDiscoveryPath?: string;
  providerFormat: "openai" | "gemini";
  defaultModel: string;
  models?: ModelEntry[];
}

/** GitHub access persisted with a bot. The token is encrypted before this reaches storage. */
export interface GitHubToolsConfigStored {
  enabled: boolean;
  publicReadEnabled: boolean;
  codingAgentEnabled: boolean;
  /** Optional dedicated provider for coding tasks. Omitted to follow the active chat provider. */
  codingProviderId?: string;
  /** Optional dedicated model within codingProviderId. Omitted to use that provider's default. */
  codingModelId?: string;
  encryptedToken?: string;
  /** GitHub App installation metadata. Installation access tokens are never persisted. */
  githubAppInstallation?: GitHubAppInstallationStored;
  login?: string;
  authorName: string;
  authorEmail: string;
  /** owner/repository entries that administrators may access with the configured identity. */
  repositories: string[];
}

export interface GitHubAppInstallationStored {
  installationId: number;
  accountLogin: string;
  accountType: string;
  repositorySelection: "all" | "selected";
  repositories: string[];
  permissions: Record<string, string>;
  connectedAt: string;
}

/** GitHub access returned to the general AI settings panel. Installation details use admin routes. */
export interface GitHubToolsConfigPublic extends Omit<
  GitHubToolsConfigStored,
  "encryptedToken" | "githubAppInstallation"
> {
  hasToken: boolean;
}

/** Decrypted, in-memory-only configuration used by the bot runtime. */
export interface GitHubToolsRuntimeConfig extends Omit<GitHubToolsConfigStored, "encryptedToken"> {
  token?: string;
  /** Resolves a short-lived GitHub App installation token immediately before an operation. */
  tokenProvider?: () => Promise<string | undefined>;
}

export interface GitHubCodeTaskInput {
  repository: string;
  task: string;
  branch: string;
  baseRef?: string;
  commitMessage?: string;
}

export interface GitHubCodeTaskResult {
  repository: string;
  branch: string;
  commitSha: string;
  changedFiles: string[];
  summary: string;
  status: "committed" | "no_changes";
}

export interface GitHubPushPreview {
  repository: string;
  branch: string;
  commitSha: string;
  remoteCommitSha?: string;
}

export interface GitHubPushResult {
  summary: string;
  url?: string;
}

export interface GitHubWorkspaceInspection {
  repository: string;
  branch: string;
  headSha: string;
  clean: boolean;
  changedFiles: string[];
  fingerprint: string;
}

export interface GitHubWorkspaceResumeInput {
  repository: string;
  task: string;
  commitMessage?: string;
}

export interface GitHubWorkspaceDiscardResult {
  repository: string;
  branch: string;
  headSha: string;
  clean: boolean;
  remainingFiles: string[];
  summary: string;
}

export interface AiConfigStored {
  engagement?: EngagementConfigStored;
  enabled: boolean;
  /** @deprecated migrated into providers[0].encryptedApiKey — kept for rollback compat */
  encryptedApiKey: string | null;
  /** @deprecated migrated into providers[0].baseURL */
  baseURL: string;
  /** @deprecated migrated into providers[0].defaultModel */
  model: string;
  /** @deprecated migrated into providers[0].providerFormat */
  providerFormat?: "openai" | "gemini";
  providers?: AiProviderEntry[];
  activeProviderId?: string;
  /** Selected global model. Missing values inherit the active Provider default. */
  activeModelId?: string;
  /** Safe Provider/model labels are visible to authorized readers by default. */
  aiSelectionDisplayDefault?: "show" | "hide";
  systemPrompt: string;
  behavioralPrompt?: string;
  groupBehavioralPrompt?: string;
  triggerConfig: AiTriggerConfig;
  groupOverrides: Record<string, AiGroupOverride>;
  conversationConfig?: ConversationConfig;
  memoryConfig?: MemoryConfig;
  stickerPacks?: string[];
  webToolsConfig?: WebToolsConfig;
  imageGenerationReceiptConfig?: ImageGenerationReceiptConfig;
  agentToolsConfig?: AgentToolsConfig;
  githubToolsConfig?: GitHubToolsConfigStored;
  artworkToolsConfig?: ArtworkToolsConfig;
  botMemoryConfig?: BotMemoryConfig;
  messageConfig?: MessageConfig;
  executionConfig?: AiExecutionConfig;
  /** @deprecated migrated into providers[0].models */
  models?: ModelEntry[];
  modelCommandAccess?: "admin" | "all";
  embeddingConfig?: EmbeddingConfig;
  dataFilesConfig?: DataFilesInjectionConfig;
  privateChatAccess?: "all" | "admin" | "allowlist";
  privateChatWhitelist?: number[];
  timeoutConfig?: TimeoutConfig;
  mcpServerIds?: number[];
  summaryConfig?: SummaryConfigStored;
  imageOcrConfig?: ImageOcrConfig;
  skillConfig?: BotSkillConfigStored;
}

export interface BotCustomSkillStored {
  id: string;
  name: string;
  displayName: string;
  description: string;
  instructions: string;
  resources: Record<string, string>;
  enabled: boolean;
}

export interface BotSkillConfigStored {
  /** Missing means every bundled default is enabled; an empty array disables all built-ins. */
  enabledBuiltInIds?: string[];
  customSkills: BotCustomSkillStored[];
}

// ─── Image OCR ───

export interface ImageOcrConfig {
  enabled: boolean;
  providerId?: string;
  modelId?: string;
  systemPrompt?: string;
  maxImagesPerMessage?: number;
  cooldownSeconds?: number;
  maxDescriptionLength?: number;
  timeoutMs?: number;
  /** Maximum size of each Telegram image forwarded to the main model. */
  maxInputImageBytes?: number;
}

export const DEFAULT_MAX_MODEL_INPUT_IMAGE_BYTES = 20 * 1024 * 1024;

export const DEFAULT_OCR_PROMPT = `你在为一个中文聊天机器人描述用户发来的图片，帮它理解后续对话。请用中文输出一段 2-4 句的自然描述，覆盖以下要素（有则描述，没有的略过，不要编造）：

1. 主体：人物（性别 / 年龄感 / 表情 / 动作 / 服装）、动物、物品，或画面主要内容；
2. 场景：地点 / 背景 / 时间 / 氛围；
3. 文字：如有明显文字（截图、表情包文字、标语、UI 文案等），原样转述关键短句；
4. 类型 / 风格：照片、二次元插画、表情包、meme、截图、漫画、手绘、AI 生成等；
5. 情绪或用意（如能合理推断）：搞笑 / 吐槽 / 炫耀 / 求助 / 晒图等，口吻中性，避免武断。

约束：
- 只描述画面中真实存在的内容，不要推测画面外信息；
- 不要输出 "这张图片 / 图中显示" 之类冗余开场，直接描述；
- 不要使用 markdown、列表或换行，输出一段紧凑的自然语言；
- 总长度控制在 150 字以内。`;
export const DEFAULT_MAX_IMAGES_PER_MESSAGE = 3;
export const DEFAULT_OCR_COOLDOWN_SECONDS = 0;
export const DEFAULT_OCR_MAX_DESCRIPTION_LENGTH = 400;
export const DEFAULT_OCR_TIMEOUT_MS = 600_000;

// ─── Summary ───

export type SummaryMode =
  | { kind: "default" }
  | { kind: "recent"; count: number }
  | { kind: "hours"; hours: number }
  | { kind: "date"; day: "today" | "yesterday" };

export type SummaryTrigger = "manual" | "scheduled";
export type SummaryAccessMode = "all" | "admin";

export interface SummaryConfigRecord {
  id: number;
  botId: string;
  chatId: number;
  isActive: boolean;
  scheduleHour: number | null;
  scheduleMinute: number | null;
  timezone: string | null;
  windowHours: number;
  customPrompt: string | null;
  providerId: string | null;
  modelId: string | null;
  maxMessages: number | null;
  cooldownSeconds: number | null;
  accessMode: SummaryAccessMode;
  lastScheduledAt: string | null;
  lastManualAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ChatAiSelectionRecord {
  botId: string;
  chatId: number;
  providerId: string;
  modelId: string | null;
  revision: number;
  updatedByKind: "telegram_user" | "better_auth_user" | null;
  updatedById: string | null;
  createdAt: string;
  updatedAt: string;
}

export type ChatAiSelectionMigrationOutcome =
  | "migrated_pair"
  | "migrated_provider_default"
  | "inherited"
  | "ignored";

export type ChatAiSelectionMigrationReason =
  | "provider_only_valid"
  | "provider_only_invalid_provider"
  | "model_only_valid"
  | "model_only_no_effective_provider"
  | "model_only_invalid_model"
  | "pair_valid"
  | "pair_invalid_model_provider_default"
  | "pair_invalid_provider"
  | "non_group_chat"
  | "unsafe_chat_id";

export interface ChatAiSelectionMigrationReportRecord {
  botId: string;
  chatId: number;
  legacyProviderId: string | null;
  legacyModelId: string | null;
  effectiveProviderId: string | null;
  selectedProviderId: string | null;
  selectedModelId: string | null;
  outcome: ChatAiSelectionMigrationOutcome;
  reason: ChatAiSelectionMigrationReason;
  migratedAt: string;
}

export interface ChatSummaryRecord {
  id: number;
  botId: string;
  chatId: number;
  trigger: SummaryTrigger;
  triggeredBy: number | null;
  windowStart: string;
  windowEnd: string;
  messageCount: number;
  modelId: string;
  content: string;
  promptTokens: number | null;
  completionTokens: number | null;
  durationMs: number | null;
  errorMessage: string | null;
  createdAt: string;
}

export interface SummaryConfigStored {
  enabled: boolean;
  defaultWindowHours: number;
  defaultMaxMessages: number;
  defaultCooldownSeconds: number;
  globalScheduleHour?: number;
  globalScheduleMinute?: number;
  modelId?: string;
  systemPrompt?: string;
  roleFilter?: Array<"user" | "context" | "assistant">;
  timezone?: string;
}

export type McpTransport = "sse" | "streamable-http";

export interface McpServerRecord {
  id: number;
  name: string;
  description: string | null;
  transport: McpTransport;
  url: string;
  hasHeaders: boolean;
  presetId: string | null;
  isActive: boolean;
  toolNamePrefix: string | null;
  createdAt: string;
  updatedAt: string | null;
}

export interface McpServerToolInfo {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface McpServerStatus {
  serverId: number;
  connected: boolean;
  toolCount: number;
  tools: McpServerToolInfo[];
  lastConnectedAt: string | null;
  error: string | null;
}

export interface McpServerPreset {
  id: string;
  name: string;
  description: string;
  transport: McpTransport;
  url: string;
  headerTemplate?: Record<string, string>;
  docsUrl?: string;
}

export interface EmbeddingConfigPublic {
  enabled: boolean;
  hasApiKey: boolean;
  baseURL: string;
  model: string;
  dimensions: number;
}

export interface AiConfigPublic {
  engagement?: EngagementConfigPublic;
  enabled: boolean;
  /** @deprecated reflects providers[activeProviderId].hasApiKey for backward compat */
  hasApiKey: boolean;
  /** @deprecated reflects providers[activeProviderId].baseURL */
  baseURL: string;
  /** @deprecated reflects providers[activeProviderId].defaultModel */
  model: string;
  /** @deprecated reflects providers[activeProviderId].providerFormat */
  providerFormat?: "openai" | "gemini";
  providers: AiProviderEntryPublic[];
  activeProviderId?: string;
  activeModelId?: string;
  aiSelectionDisplayDefault?: "show" | "hide";
  systemPrompt: string;
  behavioralPrompt?: string;
  groupBehavioralPrompt?: string;
  triggerConfig: AiTriggerConfig;
  groupOverrides: Record<string, AiGroupOverride>;
  conversationConfig?: ConversationConfig;
  memoryConfig?: MemoryConfig;
  stickerPacks?: string[];
  webToolsConfig?: WebToolsConfigPublic;
  imageGenerationReceiptConfig?: ImageGenerationReceiptConfig;
  agentToolsConfig?: AgentToolsConfig;
  githubToolsConfig?: GitHubToolsConfigPublic;
  artworkToolsConfig?: ArtworkToolsConfig;
  botMemoryConfig?: BotMemoryConfig;
  messageConfig?: MessageConfig;
  executionConfig: AiExecutionConfig;
  /** @deprecated reflects providers[activeProviderId].models */
  models?: ModelEntry[];
  modelCommandAccess?: "admin" | "all";
  embeddingConfig?: EmbeddingConfigPublic;
  dataFilesConfig?: DataFilesInjectionConfig;
  privateChatAccess?: "all" | "admin" | "allowlist";
  privateChatWhitelist?: number[];
  timeoutConfig?: TimeoutConfig;
  mcpServerIds?: number[];
  summaryConfig?: SummaryConfigStored;
  imageOcrConfig?: ImageOcrConfig;
}

export type CommandEntity = {
  name: string;
  args: string[];
  original_msg: string;
};

export type BotPlatform = "telegram" | "lark-webhook";

export interface LarkWebhookConfig {
  webhookUrl: string;
  encryptedSignSecret?: string;
}

export interface EmailForwardFilter {
  senderPattern?: string;
  subjectPattern?: string;
}

export const ALL_EMAIL_EVENT_TYPES = [
  "pr:approved",
  "pr:changes_requested",
  "pr:commented",
  "pr:merged",
  "pr:opened",
  "pr:review_requested",
  "pr:pushed",
  "pr:unknown",
  "ci:failed",
  "ci:cancelled",
  "ci:succeeded",
  "ci:completed",
  "issue:opened",
  "issue:closed",
  "issue:commented",
  "issue:unknown",
  "generic",
] as const;

export type EmailEventType = (typeof ALL_EMAIL_EVENT_TYPES)[number];

export interface EmailForwardConfig {
  imapHost: string;
  imapPort: number;
  imapTls: boolean;
  email: string;
  encryptedPassword: string;
  pollIntervalSec: number;
  filters: EmailForwardFilter[];
  larkMentionMap?: Record<string, string>;
  disabledEventTypes?: EmailEventType[];
}

export type BotStatus = "running" | "stopped" | "restarting";
export type TelegramRichMessageFormat = "markdown" | "html";

export interface TelegramRichMessageReceipt {
  messageId: number;
  chatId: number;
  format: TelegramRichMessageFormat;
}

export interface TelegramRichMessageSender {
  sendRichMessage(
    chatId: number,
    format: TelegramRichMessageFormat,
    content: string,
  ): Promise<TelegramRichMessageReceipt>;
}

export interface IBotManager {
  readonly botId: string;
  readonly status: BotStatus;
  readonly uptime: number | null;
  start(): Promise<void>;
  stop(): Promise<void>;
  sendHtml(chatId: number, html: string): Promise<void>;
}

export type LogLevel = "debug" | "info" | "warn" | "error";

export interface EmailForwardConfigPublic {
  imapHost: string;
  imapPort: number;
  email: string;
  pollIntervalSec: number;
  filters: EmailForwardFilter[];
  larkMentionMap?: Record<string, string>;
  disabledEventTypes?: EmailEventType[];
  hasPassword: boolean;
}

export const DEFAULT_LARK_MENTION_MAP: Record<string, string> = {
};

/** Relay destination for the `/cosinside` private-chat channel. Aliases are the only
 *  target selector the command accepts; raw chat IDs never reach the Telegram side. */
export interface CosInsideTarget {
  alias: string;
  chatId: number;
}

export interface CosInsideConfig {
  targets: CosInsideTarget[];
}

export interface BotRecord {
  id: string;
  name: string;
  platform: BotPlatform;
  tokenMasked: string;
  adminChatIds: number[];
  isActive: boolean;
  miniAppEnabled: boolean;
  aiEnabled: boolean;
  aiHasApiKey: boolean;
  createdAt: string;
  updatedAt: string | null;
  larkWebhookConfig?: { webhookUrl: string; hasSignSecret: boolean };
  emailForwardConfig?: EmailForwardConfigPublic;
  cosInsideConfig?: CosInsideConfig;
}

export interface BotWithStatus extends BotRecord {
  status: BotStatus;
  uptime: number | null;
}

export interface LogEntry {
  id: number;
  botId: string | null;
  level: LogLevel;
  message: string;
  meta: unknown;
  createdAt: string;
}

export interface BotLogEntry {
  level: LogLevel;
  message: string;
  meta?: Record<string, unknown>;
}

// Backup types

export type BackupStorageType = "local" | "webdav" | "s3";

export interface BackupConfigLocal {
  type: "local";
}
export interface BackupConfigWebDAV {
  type: "webdav";
  url: string;
  username: string;
  encryptedPassword: string;
}
export interface BackupConfigS3 {
  type: "s3";
  bucket: string;
  region: string;
  endpoint?: string;
  accessKeyId: string;
  encryptedSecretKey: string;
  prefix?: string;
  forcePathStyle?: boolean;
  storageClass?: string;
  serverSideEncryption?: string;
  sseKmsKeyId?: string;
}

export type BackupStorageConfig = BackupConfigLocal | BackupConfigWebDAV | BackupConfigS3;

export interface BackupRetentionConfig {
  maxCount?: number;
}

export interface BackupConfig {
  storage: BackupStorageConfig;
  filePrefix?: string;
  retention?: BackupRetentionConfig;
}

export type BackupStatus = "completed" | "failed";

export interface BackupResult {
  ok: boolean;
  filename?: string;
  error?: string;
}

export interface BackupRecord {
  id: number;
  filename: string;
  sizeBytes: number;
  durationMs: number;
  remoteUrl: string | null;
  remoteProvider: string | null;
  status: BackupStatus;
  error: string | null;
  createdAt: string;
}

// NSFW detection types

export const DEFAULT_NSFW_THRESHOLD = 0.5;

export interface NsfwScores {
  porn: number;
  sexy: number;
  hentai: number;
  neutral: number;
  drawing: number;
}

// PixAI generation tracking types

export type PixAIGenerationStatus = "pending" | "completed" | "failed";

export interface PixAIGenerationRecord {
  chatId: number;
  userId?: number;
  taskId: string;
  prompt: string;
  negativePrompt?: string;
  modelId: string;
  width: number;
  height: number;
  batchSize: number;
  samplingSteps?: number;
  cfgScale?: number;
  promptHelper?: boolean;
  pixaiConfig?: PixAIConfig;
  status: PixAIGenerationStatus;
  mediaUrls?: string[];
  mediaIds?: string[];
  localFiles?: string[];
  nsfwScores?: NsfwScores[];
  errorMessage?: string;
  durationMs?: number;
}

// Token usage types

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

// Data transfer types

export interface ExportManifest {
  version: 1;
  exportedAt: string;
  scope: "bot" | "full";
  botId?: string;
  botName?: string;
  tables: string[];
  counts: Record<string, number>;
}

export interface ExportPayload {
  manifest: ExportManifest;
  settings?: Array<Record<string, unknown>>;
  bots: Array<Record<string, unknown>>;
  [tableName: string]: unknown;
}

export interface ImportResult {
  importedBots: Array<{ oldId: string; newId: string; name: string }>;
  counts: Record<string, number>;
}

// RSS types

export interface RssCollectionRecord {
  id: number;
  botId: string;
  chatId: number;
  name: string;
  description: string | null;
  digestPrompt: string | null;
  isActive: boolean;
  digestHour: number;
  digestMinute: number;
  maxDigestItems: number | null;
  lastDigestAt: string | null;
  createdAt: string;
  updatedAt: string | null;
}

export interface RssFeedRecord {
  id: number;
  collectionId: number;
  feedUrl: string;
  title: string;
  maxDigestItems: number | null;
  lastFetchAt: string | null;
  createdAt: string;
}

export interface RssItemRecord {
  id: number;
  feedId: number;
  guid: string;
  title: string;
  link: string;
  summary: string | null;
  publishedAt: string | null;
  fetchedAt: string;
  digestedAt: string | null;
}

// Timer types

export type TimerType = "ai" | "system";
export type TimerStatus = "active" | "processing" | "fired" | "cancelled";

export interface TimerRecord {
  id: string;
  botId: string | null;
  type: TimerType;
  name: string;
  chatId: number | null;
  status: TimerStatus;
  intervalMs: number | null;
  firesAt: string | null;
  createdAt: string;
  firedAt: string | null;
  meta: Record<string, unknown> | null;
}
