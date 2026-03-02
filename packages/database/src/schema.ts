import {
  bigint,
  boolean,
  index,
  integer,
  json,
  pgTable,
  serial,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  vector,
} from "drizzle-orm/pg-core";

/** Vector embedding dimensions — must match DDL column definition.
 *  Configurable via `EMBEDDING_DIMENSIONS` env var (default 1536).
 *  Changing after deployment requires regenerating migrations + reindexing. */
export const EMBEDDING_DIMENSIONS = Number(process.env["EMBEDDING_DIMENSIONS"]) || 768;

/** Mirrors AiConfigStored from @cos-tool-bot/shared — kept inline to avoid circular dependency.
 *  SYNC: update this type when changing AiConfigStored in packages/shared/src/types.ts */
interface AiConfigJson {
  enabled: boolean;
  encryptedApiKey: string | null;
  baseURL: string;
  model: string;
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
      provider: "openai" | "custom";
      apiKey?: string;
      baseURL?: string;
      model?: string;
      size?: string;
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
    autoSplitThreshold: number;
    splitDelayMs: number;
  };
  models?: Array<{
    id: string;
    label?: string;
    capabilities?: Array<
      "vision" | "tool_calling" | "web_search" | "reasoning" | "long_context" | "code"
    >;
    temperature?: number;
    maxTokens?: number;
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
  encryptedToken: text("encrypted_token").notNull(),
  adminChatIds: json("admin_chat_ids").$type<number[]>().notNull().default([]),
  aiConfig: json("ai_config").$type<AiConfigJson>(),
  isActive: boolean("is_active").notNull().default(true),
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
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (t) => [index("bot_logs_bot_id_idx").on(t.botId)],
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
    meta: json("meta").$type<Record<string, unknown>>(),
    embedding: vector("embedding", { dimensions: EMBEDDING_DIMENSIONS }),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (t) => [
    index("conv_msg_bot_chat_idx").on(t.botId, t.chatId),
    index("conv_msg_created_idx").on(t.createdAt),
    index("conv_msg_embedding_idx").using("hnsw", t.embedding.op("vector_cosine_ops")),
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
    summarizedUpToId: integer("summarized_up_to_id").notNull(),
    messageCount: integer("message_count").notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (t) => [index("conv_summary_bot_chat_idx").on(t.botId, t.chatId)],
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
  (t) => [index("people_bot_telegram_idx").on(t.botId, t.telegramId)],
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
    embedding: vector("embedding", { dimensions: EMBEDDING_DIMENSIONS }),
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
    index("bot_memories_embedding_idx").using("hnsw", t.embedding.op("vector_cosine_ops")),
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
