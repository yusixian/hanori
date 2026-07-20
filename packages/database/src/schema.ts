import type { EmailForwardConfig, LarkWebhookConfig } from "@cos-tool-bot/shared";
import {
  bigint,
  boolean,
  index,
  integer,
  json,
  pgTable,
  primaryKey,
  real,
  serial,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  halfvec,
} from "drizzle-orm/pg-core";

/** Vector embedding dimensions — must match DDL column definition.
 *  Configurable via `EMBEDDING_DIMENSIONS` env var (default 3072).
 *  Changing after deployment requires regenerating migrations + reindexing. */
export const EMBEDDING_DIMENSIONS = Number(process.env["EMBEDDING_DIMENSIONS"]) || 3072;

/** Mirrors AiConfigStored from @cos-tool-bot/shared — kept inline to avoid circular dependency.
 *  SYNC: update this type when changing AiConfigStored in packages/shared/src/types.ts */
interface AiProviderEntryJson {
  id: string;
  label: string;
  encryptedApiKey: string | null;
  baseURL: string;
  providerFormat: "openai" | "gemini";
  defaultModel: string;
  models?: Array<{
    id: string;
    label?: string;
    capabilities?: Array<
      "vision" | "tool_calling" | "web_search" | "reasoning" | "long_context" | "code"
    >;
    temperature?: number;
    maxTokens?: number;
  }>;
}

interface AiConfigJson {
  enabled: boolean;
  encryptedApiKey: string | null;
  baseURL: string;
  model: string;
  providerFormat?: "openai" | "gemini";
  providers?: AiProviderEntryJson[];
  activeProviderId?: string;
  systemPrompt: string;
  behavioralPrompt?: string;
  groupBehavioralPrompt?: string;
  triggerConfig: {
    replyToBot: boolean;
    mentionBot: boolean;
    triggerWords: string[];
    randomReplyPercent: number;
    randomReplyCooldown: number;
  };
  groupOverrides: Record<
    string,
    {
      chatId: number;
      chatTitle?: string;
      enabled?: boolean;
      whitelisted: boolean;
      systemPrompt?: string;
      triggerConfig?: Partial<{
        replyToBot: boolean;
        mentionBot: boolean;
        triggerWords: string[];
        randomReplyPercent: number;
        randomReplyCooldown: number;
      }>;
      conversationEnabled?: boolean;
      maxContextMessages?: number;
    }
  >;
  conversationConfig?: {
    enabled: boolean;
    maxContextMessages: number;
    historyFormat?: "prompt" | "messages";
    groupBufferSize: number;
    groupContextMode: "all" | "random_only" | "none";
    saveGroupContext: "random_only" | "all" | "none";
    autoSummarize: boolean;
    summarizeThreshold: number;
    retentionDays: number;
    maxRawMessagesPerChat: number;
  };
  memoryConfig?: {
    enabled: boolean;
    maxSteps: number;
    autoReadProfile: boolean;
    autoUpdateLastSeen: boolean;
    toolChoice: "auto" | "required";
  };
  stickerPacks?: string[];
  webToolsConfig?: {
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
      pixaiConfig?: {
        negativePrompts?: string;
        samplingSteps?: number;
        cfgScale?: number;
        width?: number;
        height?: number;
        batchSize?: number;
        promptHelper?: boolean;
        systemImagePrompt?: string;
        apiMode?: "graphql" | "rest";
        priority?: number;
        seed?: string;
        clipSkip?: number;
        lightning?: boolean;
        modelStyle?: { type: "key"; keyId: string };
        inferenceProfile?: string;
        samplingMethod?: string;
        qualityTag?: { prefix: string; suffix: string };
        isPrivate?: boolean;
        nsfwThreshold?: number;
      };
    };
  };
  agentToolsConfig?: {
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
  };
  githubToolsConfig?: {
    enabled: boolean;
    publicReadEnabled: boolean;
    codingAgentEnabled: boolean;
    encryptedToken?: string;
    login?: string;
    authorName: string;
    authorEmail: string;
    repositories: string[];
  };
  artworkToolsConfig?: {
    enabled: boolean;
    pixivCookie?: string;
  };
  botMemoryConfig?: {
    enabled: boolean;
    maxMemories: number;
    autoInjectMemories: boolean;
  };
  messageConfig?: {
    replyMode?: "stream" | "segment";
    autoSplitThreshold: number;
    splitDelayMs: number;
    richMessageEnabled?: boolean;
  };
  models?: Array<{
    id: string;
    label?: string;
    capabilities?: Array<
      "vision" | "tool_calling" | "web_search" | "reasoning" | "long_context" | "code"
    >;
    temperature?: number;
    maxTokens?: number;
    thinking?: "enabled" | "disabled";
    thinkingBudget?: number;
  }>;
  modelCommandAccess?: "admin" | "all";
  embeddingConfig?: {
    enabled: boolean;
    encryptedApiKey: string;
    baseURL: string;
    model: string;
    dimensions: number;
  };
  dataFilesConfig?: {
    injectableFiles: string[];
    maxTotalSize: number;
  };
  privateChatWhitelist?: number[];
  timeoutConfig?: {
    aiReplyMs?: number;
    searchMs?: number;
    fetchPageMs?: number;
    imageGenerationMs?: number;
    researcherAgentMs?: number;
    defaultAgentMs?: number;
    imageDownloadMs?: number;
    pixaiTaskMs?: number;
  };
  mcpServerIds?: number[];
  summaryConfig?: {
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
  };
  imageOcrConfig?: {
    enabled: boolean;
    providerId?: string;
    modelId?: string;
    systemPrompt?: string;
    maxImagesPerMessage?: number;
    cooldownSeconds?: number;
    maxDescriptionLength?: number;
    timeoutMs?: number;
  };
}

export const settings = pgTable("settings", {
  key: text("key").primaryKey(),
  value: text("value").notNull(),
  updatedAt: timestamp("updated_at")
    .defaultNow()
    .$onUpdate(() => new Date()),
});

export const bots = pgTable("bots", {
  id: uuid("id").defaultRandom().primaryKey(),
  name: text("name").notNull(),
  platform: text("platform").notNull().default("telegram"),
  encryptedToken: text("encrypted_token").notNull(),
  adminChatIds: json("admin_chat_ids").$type<number[]>().notNull().default([]),
  aiConfig: json("ai_config").$type<AiConfigJson>(),
  larkWebhookConfig: json("lark_webhook_config").$type<LarkWebhookConfig>(),
  emailForwardConfig: json("email_forward_config").$type<EmailForwardConfig>(),
  isActive: boolean("is_active").notNull().default(true),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at")
    .defaultNow()
    .$onUpdate(() => new Date()),
});

export const mcpServers = pgTable("mcp_servers", {
  id: serial("id").primaryKey(),
  name: text("name").notNull(),
  description: text("description"),
  transport: text("transport").notNull().default("sse"),
  url: text("url").notNull(),
  encryptedHeaders: text("encrypted_headers"),
  presetId: text("preset_id"),
  isActive: boolean("is_active").notNull().default(true),
  toolNamePrefix: text("tool_name_prefix"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at")
    .defaultNow()
    .$onUpdate(() => new Date()),
});

export const botLogs = pgTable(
  "bot_logs",
  {
    id: serial("id").primaryKey(),
    botId: uuid("bot_id").references(() => bots.id, { onDelete: "cascade" }),
    level: text("level").notNull(), // 'debug' | 'info' | 'warn' | 'error'
    message: text("message").notNull(),
    meta: json("meta"),
    botRunId: uuid("bot_run_id"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (t) => [index("bot_logs_bot_id_idx").on(t.botId)],
);

export const botRuns = pgTable(
  "bot_runs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    botId: uuid("bot_id")
      .references(() => bots.id, { onDelete: "cascade" })
      .notNull(),
    source: text("source").notNull(),
    channel: text("channel").notNull(),
    mode: text("mode").notNull().default("dry-run"),
    status: text("status").notNull().default("running"),
    failureReason: text("failure_reason"),
    input: json("input").$type<Record<string, unknown>>().notNull(),
    configSnapshot: json("config_snapshot").$type<Record<string, unknown>>(),
    durationMs: integer("duration_ms"),
    pinned: boolean("pinned").notNull().default(false),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    completedAt: timestamp("completed_at"),
  },
  (t) => [index("bot_runs_bot_created_idx").on(t.botId, t.createdAt)],
);

export const botRunEvents = pgTable(
  "bot_run_events",
  {
    id: serial("id").primaryKey(),
    runId: uuid("run_id")
      .references(() => botRuns.id, { onDelete: "cascade" })
      .notNull(),
    sequence: integer("sequence").notNull(),
    kind: text("kind").notNull(),
    level: text("level").notNull().default("info"),
    data: json("data").$type<Record<string, unknown>>().notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex("bot_run_events_run_sequence_idx").on(t.runId, t.sequence),
    index("bot_run_events_run_idx").on(t.runId),
  ],
);

export const conversationMessages = pgTable(
  "conversation_messages",
  {
    id: serial("id").primaryKey(),
    botId: uuid("bot_id")
      .references(() => bots.id, { onDelete: "cascade" })
      .notNull(),
    chatId: bigint("chat_id", { mode: "number" }).notNull(),
    role: text("role").notNull(), // 'user' | 'assistant' | 'context' | 'system' | 'tool_call' | 'tool_result'
    content: text("content").notNull(),
    userId: bigint("user_id", { mode: "number" }),
    userName: text("user_name"),
    sourceKey: text("source_key"),
    meta: json("meta").$type<Record<string, unknown>>(),
    embedding: halfvec("embedding", { dimensions: EMBEDDING_DIMENSIONS }),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (t) => [
    index("conv_msg_bot_chat_idx").on(t.botId, t.chatId, t.id),
    uniqueIndex("conv_msg_bot_chat_source_uniq").on(t.botId, t.chatId, t.sourceKey),
    index("conv_msg_created_idx").on(t.createdAt),
    index("conv_msg_embedding_idx").using("hnsw", t.embedding.op("halfvec_cosine_ops")),
  ],
);

export const conversationSummaries = pgTable(
  "conversation_summaries",
  {
    id: serial("id").primaryKey(),
    botId: uuid("bot_id")
      .references(() => bots.id, { onDelete: "cascade" })
      .notNull(),
    chatId: bigint("chat_id", { mode: "number" }).notNull(),
    content: text("content").notNull(),
    previousSummarizedUpToId: integer("previous_summarized_up_to_id"),
    summarizedUpToId: integer("summarized_up_to_id").notNull(),
    messageCount: integer("message_count").notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (t) => [index("conv_summary_bot_chat_idx").on(t.botId, t.chatId)],
);

export const conversationCompactionState = pgTable(
  "conversation_compaction_state",
  {
    botId: uuid("bot_id")
      .references(() => bots.id, { onDelete: "cascade" })
      .notNull(),
    chatId: bigint("chat_id", { mode: "number" }).notNull(),
    activeSummaryId: integer("active_summary_id")
      .references(() => conversationSummaries.id, { onDelete: "no action" })
      .notNull(),
    updatedAt: timestamp("updated_at")
      .defaultNow()
      .$onUpdate(() => new Date())
      .notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.botId, t.chatId] }),
    index("conv_compaction_active_summary_idx").on(t.activeSummaryId),
  ],
);

export const peopleProfiles = pgTable(
  "people_profiles",
  {
    id: serial("id").primaryKey(),
    botId: uuid("bot_id")
      .references(() => bots.id, { onDelete: "cascade" })
      .notNull(),
    telegramId: bigint("telegram_id", { mode: "number" }).notNull(),
    username: text("username"),
    displayName: text("display_name"),
    firstName: text("first_name"),
    lastName: text("last_name"),
    languageCode: text("language_code"),
    isPremium: boolean("is_premium").notNull().default(false),
    avatarPath: text("avatar_path"),
    avatarVersion: text("avatar_version"),
    avatarRefreshVersion: bigint("avatar_refresh_version", { mode: "number" }).notNull().default(0),
    notes: text("notes"),
    traits: json("traits").$type<string[]>().default([]),
    interests: json("interests").$type<string[]>().default([]),
    relationship: text("relationship"),
    firstSeen: timestamp("first_seen").defaultNow().notNull(),
    lastSeen: timestamp("last_seen").defaultNow().notNull(),
    updatedAt: timestamp("updated_at")
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [uniqueIndex("people_bot_telegram_idx").on(t.botId, t.telegramId)],
);

export const backups = pgTable("backups", {
  id: serial("id").primaryKey(),
  filename: text("filename").notNull(),
  sizeBytes: integer("size_bytes").notNull(),
  durationMs: integer("duration_ms").notNull(),
  remoteUrl: text("remote_url"),
  remoteProvider: text("remote_provider"),
  status: text("status").notNull(),
  error: text("error"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const botMemories = pgTable(
  "bot_memories",
  {
    id: serial("id").primaryKey(),
    botId: uuid("bot_id")
      .references(() => bots.id, { onDelete: "cascade" })
      .notNull(),
    telegramId: bigint("telegram_id", { mode: "number" }),
    content: text("content").notNull(),
    category: text("category"),
    embedding: halfvec("embedding", { dimensions: EMBEDDING_DIMENSIONS }),
    factValidAt: timestamp("fact_valid_at"),
    supersededById: integer("superseded_by_id"),
    isActive: boolean("is_active").notNull().default(true),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at")
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [
    index("bot_memories_bot_telegram_idx").on(t.botId, t.telegramId),
    index("bot_memories_bot_category_idx").on(t.botId, t.category),
    index("bot_memories_embedding_idx").using("hnsw", t.embedding.op("halfvec_cosine_ops")),
  ],
);

export const chatModelOverrides = pgTable(
  "chat_model_overrides",
  {
    id: serial("id").primaryKey(),
    botId: uuid("bot_id")
      .references(() => bots.id, { onDelete: "cascade" })
      .notNull(),
    chatId: bigint("chat_id", { mode: "number" }).notNull(),
    modelId: text("model_id").notNull(),
    updatedAt: timestamp("updated_at")
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [uniqueIndex("chat_model_bot_chat_uniq").on(t.botId, t.chatId)],
);

export const chatProviderOverrides = pgTable(
  "chat_provider_overrides",
  {
    id: serial("id").primaryKey(),
    botId: uuid("bot_id")
      .references(() => bots.id, { onDelete: "cascade" })
      .notNull(),
    chatId: bigint("chat_id", { mode: "number" }).notNull(),
    providerId: text("provider_id").notNull(),
    updatedAt: timestamp("updated_at")
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [uniqueIndex("chat_provider_bot_chat_uniq").on(t.botId, t.chatId)],
);

export const pixaiGenerations = pgTable(
  "pixai_generations",
  {
    id: serial("id").primaryKey(),
    botId: uuid("bot_id")
      .references(() => bots.id, { onDelete: "cascade" })
      .notNull(),
    chatId: bigint("chat_id", { mode: "number" }).notNull(),
    userId: bigint("user_id", { mode: "number" }),
    taskId: text("task_id").notNull(),
    prompt: text("prompt").notNull(),
    negativePrompt: text("negative_prompt"),
    modelId: text("model_id").notNull(),
    width: integer("width").notNull(),
    height: integer("height").notNull(),
    batchSize: integer("batch_size").notNull().default(1),
    status: text("status").notNull().default("pending"),
    mediaUrls: json("media_urls").$type<string[]>(),
    mediaIds: json("media_ids").$type<string[]>(),
    localFiles: json("local_files").$type<string[]>(),
    samplingSteps: integer("sampling_steps"),
    cfgScale: real("cfg_scale"),
    promptHelper: boolean("prompt_helper"),
    pixaiConfig: json("pixai_config"),
    nsfwScores:
      json("nsfw_scores").$type<
        { porn: number; sexy: number; hentai: number; neutral: number; drawing: number }[]
      >(),
    errorMessage: text("error_message"),
    durationMs: integer("duration_ms"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    completedAt: timestamp("completed_at"),
  },
  (t) => [
    index("pixai_gen_bot_id_idx").on(t.botId),
    index("pixai_gen_bot_chat_idx").on(t.botId, t.chatId),
    index("pixai_gen_created_idx").on(t.createdAt),
  ],
);

export const timers = pgTable(
  "timers",
  {
    id: text("id").primaryKey(),
    botId: uuid("bot_id").references(() => bots.id, { onDelete: "cascade" }),
    type: text("type").notNull(), // 'ai' | 'system'
    name: text("name").notNull(),
    chatId: bigint("chat_id", { mode: "number" }),
    status: text("status").notNull().default("active"),
    intervalMs: integer("interval_ms"),
    firesAt: timestamp("fires_at"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    firedAt: timestamp("fired_at"),
    meta: json("meta").$type<Record<string, unknown>>(),
  },
  (t) => [index("timers_bot_id_idx").on(t.botId), index("timers_status_idx").on(t.status)],
);

export const rssCollections = pgTable(
  "rss_collections",
  {
    id: serial("id").primaryKey(),
    botId: uuid("bot_id")
      .references(() => bots.id, { onDelete: "cascade" })
      .notNull(),
    chatId: bigint("chat_id", { mode: "number" }).notNull(),
    name: text("name").notNull(),
    description: text("description"),
    digestPrompt: text("digest_prompt"),
    isActive: boolean("is_active").notNull().default(true),
    digestHour: integer("digest_hour").notNull().default(9),
    digestMinute: integer("digest_minute").notNull().default(0),
    maxDigestItems: integer("max_digest_items"),
    lastDigestAt: timestamp("last_digest_at"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at")
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [index("rss_collections_bot_chat_idx").on(t.botId, t.chatId)],
);

export const rssFeeds = pgTable(
  "rss_feeds",
  {
    id: serial("id").primaryKey(),
    collectionId: integer("collection_id")
      .references(() => rssCollections.id, { onDelete: "cascade" })
      .notNull(),
    feedUrl: text("feed_url").notNull(),
    title: text("title").notNull(),
    maxDigestItems: integer("max_digest_items"),
    lastFetchAt: timestamp("last_fetch_at"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (t) => [uniqueIndex("rss_feeds_collection_url_uniq").on(t.collectionId, t.feedUrl)],
);

export const rssItems = pgTable(
  "rss_items",
  {
    id: serial("id").primaryKey(),
    feedId: integer("feed_id")
      .references(() => rssFeeds.id, { onDelete: "cascade" })
      .notNull(),
    guid: text("guid").notNull(),
    title: text("title").notNull(),
    link: text("link").notNull(),
    summary: text("summary"),
    publishedAt: timestamp("published_at"),
    fetchedAt: timestamp("fetched_at").defaultNow().notNull(),
    digestedAt: timestamp("digested_at"),
  },
  (t) => [
    uniqueIndex("rss_items_feed_guid_uniq").on(t.feedId, t.guid),
    index("rss_items_feed_digested_idx").on(t.feedId, t.digestedAt),
  ],
);

export const tokenUsage = pgTable(
  "token_usage",
  {
    id: serial("id").primaryKey(),
    botId: uuid("bot_id")
      .references(() => bots.id, { onDelete: "cascade" })
      .notNull(),
    chatId: bigint("chat_id", { mode: "number" }).notNull(),
    userId: bigint("user_id", { mode: "number" }),
    model: text("model").notNull(),
    promptTokens: integer("prompt_tokens").notNull().default(0),
    completionTokens: integer("completion_tokens").notNull().default(0),
    totalTokens: integer("total_tokens").notNull().default(0),
    durationMs: integer("duration_ms"),
    trigger: text("trigger"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (t) => [
    index("token_usage_bot_id_idx").on(t.botId),
    index("token_usage_created_at_idx").on(t.createdAt),
    index("token_usage_bot_created_idx").on(t.botId, t.createdAt),
  ],
);

export const summaryConfigs = pgTable(
  "summary_configs",
  {
    id: serial("id").primaryKey(),
    botId: uuid("bot_id")
      .references(() => bots.id, { onDelete: "cascade" })
      .notNull(),
    chatId: bigint("chat_id", { mode: "number" }).notNull(),
    isActive: boolean("is_active").notNull().default(true),
    scheduleHour: integer("schedule_hour"),
    scheduleMinute: integer("schedule_minute"),
    windowHours: integer("window_hours").notNull().default(24),
    customPrompt: text("custom_prompt"),
    providerId: text("provider_id"),
    modelId: text("model_id"),
    maxMessages: integer("max_messages"),
    cooldownSeconds: integer("cooldown_seconds"),
    accessMode: text("access_mode").notNull().default("all"),
    lastScheduledAt: timestamp("last_scheduled_at"),
    lastManualAt: timestamp("last_manual_at"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at")
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [uniqueIndex("summary_configs_bot_chat_uniq").on(t.botId, t.chatId)],
);

export const chatSummaries = pgTable(
  "chat_summaries",
  {
    id: serial("id").primaryKey(),
    botId: uuid("bot_id")
      .references(() => bots.id, { onDelete: "cascade" })
      .notNull(),
    chatId: bigint("chat_id", { mode: "number" }).notNull(),
    trigger: text("trigger").notNull(),
    triggeredBy: bigint("triggered_by", { mode: "number" }),
    windowStart: timestamp("window_start").notNull(),
    windowEnd: timestamp("window_end").notNull(),
    messageCount: integer("message_count").notNull(),
    modelId: text("model_id").notNull(),
    content: text("content").notNull(),
    promptTokens: integer("prompt_tokens"),
    completionTokens: integer("completion_tokens"),
    durationMs: integer("duration_ms"),
    errorMessage: text("error_message"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (t) => [
    index("chat_summaries_bot_chat_idx").on(t.botId, t.chatId),
    index("chat_summaries_created_idx").on(t.createdAt),
  ],
);

// Better Auth tables. These are intentionally kept in the shared Drizzle schema so
// migrations and the Better Auth adapter use the same table definitions.
export const authUsers = pgTable(
  "user",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    email: text("email").notNull(),
    emailVerified: boolean("email_verified").notNull().default(false),
    image: text("image"),
    createdAt: timestamp("created_at").notNull(),
    updatedAt: timestamp("updated_at").notNull(),
  },
  (t) => [uniqueIndex("user_email_unique").on(t.email)],
);

export const authSessions = pgTable(
  "session",
  {
    id: text("id").primaryKey(),
    expiresAt: timestamp("expires_at").notNull(),
    token: text("token").notNull(),
    createdAt: timestamp("created_at").notNull(),
    updatedAt: timestamp("updated_at").notNull(),
    ipAddress: text("ip_address"),
    userAgent: text("user_agent"),
    activeOrganizationId: text("active_organization_id"),
    userId: text("user_id")
      .notNull()
      .references(() => authUsers.id, { onDelete: "cascade" }),
  },
  (t) => [
    uniqueIndex("session_token_unique").on(t.token),
    index("session_user_id_idx").on(t.userId),
  ],
);

export const authAccounts = pgTable(
  "account",
  {
    id: text("id").primaryKey(),
    accountId: text("account_id").notNull(),
    providerId: text("provider_id").notNull(),
    userId: text("user_id")
      .notNull()
      .references(() => authUsers.id, { onDelete: "cascade" }),
    accessToken: text("access_token"),
    refreshToken: text("refresh_token"),
    idToken: text("id_token"),
    accessTokenExpiresAt: timestamp("access_token_expires_at"),
    refreshTokenExpiresAt: timestamp("refresh_token_expires_at"),
    scope: text("scope"),
    password: text("password"),
    createdAt: timestamp("created_at").notNull(),
    updatedAt: timestamp("updated_at").notNull(),
  },
  (t) => [
    index("account_user_id_idx").on(t.userId),
    index("account_provider_idx").on(t.providerId, t.accountId),
  ],
);

export const authVerifications = pgTable(
  "verification",
  {
    id: text("id").primaryKey(),
    identifier: text("identifier").notNull(),
    value: text("value").notNull(),
    expiresAt: timestamp("expires_at").notNull(),
    createdAt: timestamp("created_at").notNull(),
    updatedAt: timestamp("updated_at").notNull(),
  },
  (t) => [index("verification_identifier_idx").on(t.identifier)],
);

export const authOrganizations = pgTable(
  "organization",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    slug: text("slug").notNull(),
    logo: text("logo"),
    metadata: text("metadata"),
    createdAt: timestamp("created_at").notNull(),
  },
  (t) => [uniqueIndex("organization_slug_unique").on(t.slug)],
);

export const authMembers = pgTable(
  "member",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => authOrganizations.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => authUsers.id, { onDelete: "cascade" }),
    role: text("role").notNull(),
    createdAt: timestamp("created_at").notNull(),
  },
  (t) => [
    uniqueIndex("member_org_user_unique").on(t.organizationId, t.userId),
    index("member_user_id_idx").on(t.userId),
  ],
);

export const authInvitations = pgTable(
  "invitation",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => authOrganizations.id, { onDelete: "cascade" }),
    email: text("email").notNull(),
    role: text("role").notNull(),
    status: text("status").notNull().default("pending"),
    teamId: text("team_id"),
    inviterId: text("inviter_id")
      .notNull()
      .references(() => authUsers.id, { onDelete: "cascade" }),
    expiresAt: timestamp("expires_at").notNull(),
    createdAt: timestamp("created_at").notNull(),
  },
  (t) => [
    index("invitation_org_id_idx").on(t.organizationId),
    index("invitation_email_idx").on(t.email),
  ],
);
