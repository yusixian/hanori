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

export interface WebToolsConfig {
  enabled: boolean;
  search?: {
    provider: "tavily" | "searxng" | "brave" | "custom";
    apiKey?: string;
    baseURL?: string;
  };
  imageGeneration?: {
    provider: "openai" | "custom";
    apiKey?: string;
    baseURL?: string;
    model?: string;
    size?: string;
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

export interface MessageConfig {
  autoSplitThreshold: number; // 0 = disabled, >0 = auto-split when text exceeds this character count
  splitDelayMs: number; // delay between split segments (ms), shows typing status
}

export const DEFAULT_MESSAGE_CONFIG: MessageConfig = {
  autoSplitThreshold: 0, // disabled by default
  splitDelayMs: 800,
};

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
}

export interface AiConfigStored {
  enabled: boolean;
  encryptedApiKey: string | null;
  baseURL: string;
  model: string;
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
