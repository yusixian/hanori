import type { AiConfigStored, EmailForwardConfig, LarkWebhookConfig } from "@cos-tool-bot/shared";
import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  check,
  foreignKey,
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
  aiConfig: json("ai_config").$type<AiConfigStored>(),
  larkWebhookConfig: json("lark_webhook_config").$type<LarkWebhookConfig>(),
  emailForwardConfig: json("email_forward_config").$type<EmailForwardConfig>(),
  isActive: boolean("is_active").notNull().default(true),
  miniAppEnabled: boolean("mini_app_enabled").notNull().default(false),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at")
    .defaultNow()
    .$onUpdate(() => new Date()),
});

export const telegramBotProfiles = pgTable(
  "telegram_bot_profiles",
  {
    botId: uuid("bot_id")
      .primaryKey()
      .references(() => bots.id, { onDelete: "cascade" }),
    telegramUserId: bigint("telegram_user_id", { mode: "number" }).notNull(),
    username: text("username").notNull(),
    displayName: text("display_name").notNull(),
    observedAt: timestamp("observed_at").defaultNow().notNull(),
  },
  (t) => [
    check(
      "telegram_bot_profiles_user_id_check",
      sql`${t.telegramUserId} > 0 and ${t.telegramUserId} <= 9007199254740991`,
    ),
  ],
);

export const telegramChats = pgTable(
  "telegram_chats",
  {
    botId: uuid("bot_id")
      .references(() => bots.id, { onDelete: "cascade" })
      .notNull(),
    chatId: bigint("chat_id", { mode: "number" }).notNull(),
    type: text("type").notNull(),
    title: text("title"),
    username: text("username"),
    botMembershipStatus: text("bot_membership_status"),
    membershipObservedAt: timestamp("membership_observed_at"),
    lastObservedAt: timestamp("last_observed_at").defaultNow().notNull(),
    leftAt: timestamp("left_at"),
    migratedToChatId: bigint("migrated_to_chat_id", { mode: "number" }),
  },
  (t) => [
    primaryKey({ columns: [t.botId, t.chatId] }),
    foreignKey({
      columns: [t.botId, t.migratedToChatId],
      foreignColumns: [t.botId, t.chatId],
      name: "telegram_chats_migrated_to_fk",
    }),
    index("telegram_chats_bot_last_observed_idx").on(t.botId, t.lastObservedAt),
    index("telegram_chats_bot_membership_idx").on(t.botId, t.botMembershipStatus),
    check(
      "telegram_chats_chat_id_check",
      sql`${t.chatId} < 0 and ${t.chatId} >= -9007199254740991`,
    ),
    check("telegram_chats_type_check", sql`${t.type} in ('group', 'supergroup')`),
    check(
      "telegram_chats_membership_status_check",
      sql`${t.botMembershipStatus} is null or ${t.botMembershipStatus} in ('creator', 'administrator', 'member', 'restricted', 'left', 'kicked')`,
    ),
    check(
      "telegram_chats_migrated_to_check",
      sql`${t.migratedToChatId} is null or (${t.migratedToChatId} < 0 and ${t.migratedToChatId} >= -9007199254740991 and ${t.migratedToChatId} <> ${t.chatId})`,
    ),
  ],
);

export const miniAppChatGrants = pgTable(
  "mini_app_chat_grants",
  {
    botId: uuid("bot_id").notNull(),
    chatId: bigint("chat_id", { mode: "number" }).notNull(),
    createdBy: bigint("created_by", { mode: "number" }).notNull(),
    note: text("note"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.botId, t.chatId] }),
    foreignKey({
      columns: [t.botId, t.chatId],
      foreignColumns: [telegramChats.botId, telegramChats.chatId],
      name: "mini_app_chat_grants_catalog_fk",
    }).onDelete("cascade"),
    check(
      "mini_app_chat_grants_chat_id_check",
      sql`${t.chatId} < 0 and ${t.chatId} >= -9007199254740991`,
    ),
    check(
      "mini_app_chat_grants_creator_check",
      sql`${t.createdBy} > 0 and ${t.createdBy} <= 9007199254740991`,
    ),
  ],
);

export const miniAppOperatorGrants = pgTable(
  "mini_app_operator_grants",
  {
    botId: uuid("bot_id")
      .references(() => bots.id, { onDelete: "cascade" })
      .notNull(),
    telegramUserId: bigint("telegram_user_id", { mode: "number" }).notNull(),
    createdBy: bigint("created_by", { mode: "number" }).notNull(),
    note: text("note"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.botId, t.telegramUserId] }),
    check(
      "mini_app_operator_grants_user_id_check",
      sql`${t.telegramUserId} > 0 and ${t.telegramUserId} <= 9007199254740991`,
    ),
    check(
      "mini_app_operator_grants_creator_check",
      sql`${t.createdBy} > 0 and ${t.createdBy} <= 9007199254740991`,
    ),
  ],
);

export const miniAppAuditEvents = pgTable(
  "mini_app_audit_events",
  {
    id: serial("id").primaryKey(),
    botId: uuid("bot_id")
      .references(() => bots.id, { onDelete: "cascade" })
      .notNull(),
    actorTelegramUserId: bigint("actor_telegram_user_id", { mode: "number" }),
    actorRole: text("actor_role").notNull(),
    capability: text("capability").notNull(),
    action: text("action").notNull(),
    resourceType: text("resource_type").notNull(),
    resourceId: text("resource_id").notNull(),
    previousSummary: json("previous_summary").$type<Record<string, unknown>>(),
    nextSummary: json("next_summary").$type<Record<string, unknown>>(),
    outcome: text("outcome").notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (t) => [
    index("mini_app_audit_events_bot_created_idx").on(t.botId, t.createdAt),
    index("mini_app_audit_events_bot_actor_idx").on(t.botId, t.actorTelegramUserId, t.createdAt),
    index("mini_app_audit_events_bot_action_idx").on(t.botId, t.action, t.createdAt),
    index("mini_app_audit_events_bot_resource_idx").on(
      t.botId,
      t.resourceType,
      t.resourceId,
      t.createdAt,
    ),
    check(
      "mini_app_audit_events_actor_id_check",
      sql`${t.actorTelegramUserId} is null or (${t.actorTelegramUserId} > 0 and ${t.actorTelegramUserId} <= 9007199254740991)`,
    ),
    check(
      "mini_app_audit_events_actor_role_check",
      sql`${t.actorRole} in ('admin', 'operator', 'viewer', 'system')`,
    ),
    check(
      "mini_app_audit_events_outcome_check",
      sql`${t.outcome} in ('succeeded', 'failed', 'partial')`,
    ),
  ],
);

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
    userAuthoredContent: text("user_authored_content"),
    userId: bigint("user_id", { mode: "number" }),
    userName: text("user_name"),
    sourceKey: text("source_key"),
    meta: json("meta").$type<Record<string, unknown>>(),
    embedding: halfvec("embedding", { dimensions: EMBEDDING_DIMENSIONS }),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (t) => [
    index("conv_msg_bot_chat_idx").on(t.botId, t.chatId, t.id),
    index("conv_msg_bot_user_role_created_idx").on(t.botId, t.userId, t.role, t.createdAt, t.id),
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
    rawHistoryIntact: boolean("raw_history_intact").default(true).notNull(),
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

export const userPrivacySettings = pgTable(
  "user_privacy_settings",
  {
    botId: uuid("bot_id")
      .references(() => bots.id, { onDelete: "cascade" })
      .notNull(),
    userId: bigint("user_id", { mode: "number" }).notNull(),
    mode: text("mode").notNull().default("normal"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at")
      .defaultNow()
      .$onUpdate(() => new Date())
      .notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.botId, t.userId] }),
    index("user_privacy_bot_mode_idx").on(t.botId, t.mode),
    check("user_privacy_mode_check", sql`${t.mode} in ('normal', 'isolated', 'off')`),
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

export const chatAiSelections = pgTable(
  "chat_ai_selections",
  {
    botId: uuid("bot_id")
      .references(() => bots.id, { onDelete: "cascade" })
      .notNull(),
    chatId: bigint("chat_id", { mode: "number" }).notNull(),
    providerId: text("provider_id").notNull(),
    modelId: text("model_id"),
    revision: integer("revision").notNull().default(1),
    updatedByKind: text("updated_by_kind"),
    updatedById: text("updated_by_id"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at")
      .defaultNow()
      .notNull()
      .$onUpdate(() => new Date()),
  },
  (t) => [
    primaryKey({ columns: [t.botId, t.chatId] }),
    check(
      "chat_ai_selections_chat_id_check",
      sql`${t.chatId} < 0 and ${t.chatId} >= -9007199254740991`,
    ),
    check("chat_ai_selections_provider_id_check", sql`length(btrim(${t.providerId})) > 0`),
    check(
      "chat_ai_selections_model_id_check",
      sql`${t.modelId} is null or length(btrim(${t.modelId})) > 0`,
    ),
    check("chat_ai_selections_revision_check", sql`${t.revision} > 0`),
    check(
      "chat_ai_selections_updated_by_pair_check",
      sql`(${t.updatedByKind} is null and ${t.updatedById} is null) or (${t.updatedByKind} is not null and ${t.updatedById} is not null)`,
    ),
    check(
      "chat_ai_selections_updated_by_kind_check",
      sql`${t.updatedByKind} is null or ${t.updatedByKind} in ('telegram_user', 'better_auth_user')`,
    ),
    check(
      "chat_ai_selections_telegram_actor_check",
      sql`${t.updatedByKind} is null or ${t.updatedByKind} <> 'telegram_user' or (${t.updatedById} ~ '^[1-9][0-9]*$' and ${t.updatedById}::numeric <= 9007199254740991)`,
    ),
  ],
);

export const chatAiSelectionMigrationReports = pgTable(
  "chat_ai_selection_migration_reports",
  {
    botId: uuid("bot_id")
      .references(() => bots.id, { onDelete: "cascade" })
      .notNull(),
    chatId: bigint("chat_id", { mode: "number" }).notNull(),
    legacyProviderId: text("legacy_provider_id"),
    legacyModelId: text("legacy_model_id"),
    effectiveProviderId: text("effective_provider_id"),
    selectedProviderId: text("selected_provider_id"),
    selectedModelId: text("selected_model_id"),
    outcome: text("outcome").notNull(),
    reason: text("reason").notNull(),
    migratedAt: timestamp("migrated_at").defaultNow().notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.botId, t.chatId] }),
    check(
      "chat_ai_selection_reports_outcome_check",
      sql`${t.outcome} in ('migrated_pair', 'migrated_provider_default', 'inherited', 'ignored')`,
    ),
    check(
      "chat_ai_selection_reports_reason_check",
      sql`${t.reason} in ('provider_only_valid', 'provider_only_invalid_provider', 'model_only_valid', 'model_only_no_effective_provider', 'model_only_invalid_model', 'pair_valid', 'pair_invalid_model_provider_default', 'pair_invalid_provider', 'non_group_chat', 'unsafe_chat_id')`,
    ),
    check(
      "chat_ai_selection_reports_selected_pair_check",
      sql`${t.selectedProviderId} is not null or ${t.selectedModelId} is null`,
    ),
  ],
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
    timezone: text("timezone"),
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
