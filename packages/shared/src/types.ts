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
export const DEFAULT_MAX_INJECTION_SIZE = 8192; // 8KB

export const DEFAULT_MEMORY_CONFIG: MemoryConfig = {
  enabled: false,
  maxSteps: 3,
  autoReadProfile: true,
  autoUpdateLastSeen: true,
  toolChoice: "auto",
};

export interface PeopleProfile {
  telegramId: number;
  username: string | null;
  displayName: string | null;
  notes: string | null;
  traits: string[];
  interests: string[];
  relationship: string | null;
  firstSeen: string;
  lastSeen: string;
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
  touchProfile(telegramId: number, displayName: string, username?: string): Promise<void>;
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
  aiReplyMs: 300_000,
  perStepMs: 60_000,
  searchMs: 30_000,
  fetchPageMs: 20_000,
  imageGenerationMs: 120_000,
  researcherAgentMs: 120_000,
  defaultAgentMs: 60_000,
  imageDownloadMs: 60_000,
  pixaiTaskMs: 600_000,
};

export interface AiTriggerConfig {
  replyToBot: boolean;
  mentionBot: boolean;
  triggerWords: string[];
  randomReplyPercent: number;
  randomReplyCooldown: number;
}

export interface AiGroupOverride {
  chatId: number;
  chatTitle?: string;
  enabled?: boolean;
  whitelisted: boolean;
  systemPrompt?: string;
  triggerConfig?: Partial<AiTriggerConfig>;
  conversationEnabled?: boolean;
  maxContextMessages?: number;
  imageGenerationEnabled?: boolean;
}

export interface ConversationConfig {
  enabled: boolean;
  maxContextMessages: number;
  historyFormat?: "prompt" | "messages";
  groupBufferSize: number;
  groupContextMode: "all" | "random_only" | "none";
  saveGroupContext: "random_only" | "all" | "none";
  autoSummarize: boolean;
  summarizeThreshold: number;
  retentionDays: number;
}

export const DEFAULT_CONVERSATION_CONFIG: ConversationConfig = {
  enabled: true,
  maxContextMessages: 20,
  historyFormat: "prompt",
  groupBufferSize: 50,
  groupContextMode: "all",
  saveGroupContext: "random_only",
  autoSummarize: true,
  summarizeThreshold: 30,
  retentionDays: 30,
};

export type ConversationRole =
  | "user"
  | "assistant"
  | "context"
  | "system"
  | "tool_call"
  | "tool_result";

export interface ConversationCallbacks {
  getHistory(
    chatId: number,
    limit: number,
  ): Promise<{
    summary: string | null;
    messages: Array<{ role: string; content: string; userName: string | null }>;
  }>;
  addMessage(params: {
    chatId: number;
    role: ConversationRole;
    content: string;
    userId?: number;
    userName?: string;
    meta?: Record<string, unknown>;
  }): Promise<void>;
  addMessages(
    messages: Array<{
      chatId: number;
      role: ConversationRole;
      content: string;
      userId?: number;
      userName?: string;
      meta?: Record<string, unknown>;
    }>,
  ): Promise<void>;
  triggerCompression(chatId: number): void;
  clearHistory(chatId: number): Promise<void>;
}

export interface PixAIRateLimitConfig {
  maxConcurrentTasks?: number; // 全局并发上限，默认 3
  maxQueueDepth?: number; // 排队深度，默认 5
  userCooldownSec?: number; // 用户冷却秒数，默认 60
  chatCooldownSec?: number; // 群聊冷却秒数，默认 30
  hourlyLimit?: number; // 每小时限额（非管理员），默认 30
  adminBypass?: boolean; // 管理员绕过，默认 true
}

export const DEFAULT_PIXAI_RATE_LIMIT: Required<PixAIRateLimitConfig> = {
  maxConcurrentTasks: 3,
  maxQueueDepth: 5,
  userCooldownSec: 60,
  chatCooldownSec: 30,
  hourlyLimit: 30,
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

export interface WebToolsConfig {
  enabled: boolean;
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
export interface BotMemory {
  id: number;
  botId: string;
  telegramId: number | null;
  content: string;
  category: string | null;
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
  autoSplitThreshold: number; // 0 = disabled, >0 = auto-split when text exceeds this character count
  splitDelayMs: number; // delay between split segments (ms), shows typing status
}

export const DEFAULT_MESSAGE_CONFIG: MessageConfig = {
  replyMode: "segment", // segment mode: multi_message tool + auto-split
  autoSplitThreshold: 0, // disabled by default
  splitDelayMs: 800,
};

export function isStreamReplyMode(config?: MessageConfig): boolean {
  return (config?.replyMode ?? DEFAULT_MESSAGE_CONFIG.replyMode) === "stream";
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
  model: "gemini-embedding-001",
  dimensions: 768,
};

export interface BotMemoryCallbacks {
  saveMemory(params: {
    content: string;
    category?: string;
    telegramId?: number;
    factValidAt?: string;
  }): Promise<BotMemory>;
  recallMemories(params: {
    query?: string;
    category?: string;
    telegramId?: number;
    scope?: "general_only" | "user_only" | "all";
    limit?: number;
  }): Promise<BotMemory[]>;
  deleteMemory(memoryId: number): Promise<boolean>;
  getMemoriesForPrompt(telegramId?: number, limit?: number): Promise<BotMemory[]>;
  searchProfiles?(query: string, telegramId?: number): Promise<PeopleProfile[]>;
}

export interface AiConfigStored {
  enabled: boolean;
  encryptedApiKey: string | null;
  baseURL: string;
  model: string;
  providerFormat?: "openai" | "gemini";
  systemPrompt: string;
  behavioralPrompt?: string;
  groupBehavioralPrompt?: string;
  triggerConfig: AiTriggerConfig;
  groupOverrides: Record<string, AiGroupOverride>;
  conversationConfig?: ConversationConfig;
  memoryConfig?: MemoryConfig;
  stickerPacks?: string[];
  webToolsConfig?: WebToolsConfig;
  agentToolsConfig?: AgentToolsConfig;
  artworkToolsConfig?: ArtworkToolsConfig;
  botMemoryConfig?: BotMemoryConfig;
  messageConfig?: MessageConfig;
  models?: ModelEntry[];
  modelCommandAccess?: "admin" | "all";
  embeddingConfig?: EmbeddingConfig;
  dataFilesConfig?: DataFilesInjectionConfig;
  privateChatWhitelist?: number[];
  timeoutConfig?: TimeoutConfig;
}

export interface EmbeddingConfigPublic {
  enabled: boolean;
  hasApiKey: boolean;
  baseURL: string;
  model: string;
  dimensions: number;
}

export interface AiConfigPublic {
  enabled: boolean;
  hasApiKey: boolean;
  baseURL: string;
  model: string;
  providerFormat?: "openai" | "gemini";
  systemPrompt: string;
  behavioralPrompt?: string;
  groupBehavioralPrompt?: string;
  triggerConfig: AiTriggerConfig;
  groupOverrides: Record<string, AiGroupOverride>;
  conversationConfig?: ConversationConfig;
  memoryConfig?: MemoryConfig;
  stickerPacks?: string[];
  webToolsConfig?: WebToolsConfig;
  agentToolsConfig?: AgentToolsConfig;
  artworkToolsConfig?: ArtworkToolsConfig;
  botMemoryConfig?: BotMemoryConfig;
  messageConfig?: MessageConfig;
  models?: ModelEntry[];
  modelCommandAccess?: "admin" | "all";
  embeddingConfig?: EmbeddingConfigPublic;
  dataFilesConfig?: DataFilesInjectionConfig;
  privateChatWhitelist?: number[];
  timeoutConfig?: TimeoutConfig;
}

export type CommandEntity = {
  name: string;
  args: string[];
  original_msg: string;
};

export type BotStatus = "running" | "stopped" | "restarting";

export type LogLevel = "debug" | "info" | "warn" | "error";

export interface BotRecord {
  id: string;
  name: string;
  tokenMasked: string;
  adminChatIds: number[];
  isActive: boolean;
  aiEnabled: boolean;
  aiHasApiKey: boolean;
  createdAt: string;
  updatedAt: string | null;
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

// Timer types

export type TimerType = "ai" | "system";
export type TimerStatus = "active" | "fired" | "cancelled";

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
