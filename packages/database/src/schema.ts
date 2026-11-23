import type { PromptSnapshot, PromptPreviewSnapshot } from "@cos-tool-bot/shared";
import type {
  AiConfigStored,
  ScheduledTaskPlan,
  AgentExecutionConfig,
  CosInsideConfig,
  EngagementContextMessage,
  EngagementLabel,
  EngagementParticipationDecision,
  EngagementPolicy,
  ImageArtifact,
  ImageGenerationEventKind,
  ImageGenerationRequestSnapshot,
  ImageGovernanceConfig,
  GenerationLibrarySettings,
  CharacterSource,
  CharacterRelation,
  PromptAssetType,
  PluginConfiguration,
  PluginManifest,
  MediaJobStatus,
  MediaJobConfirmation,
  VideoDownloadStatus,
  TranscriptDocument,
  AssetSafety,
  UsageBucketCharge,
  UsageLimits,
} from "@cos-tool-bot/shared";
import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  check,
  foreignKey,
  index,
  integer,
  json,
  numeric,
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

export const pluginInstallations = pgTable(
  "plugin_installations",
  {
    isInstalled: boolean("is_installed").notNull().default(true),
    id: text("id").primaryKey(),
    source: text("source").$type<"builtin" | "git">().notNull(),
    repository: text("repository"),
    commit: text("commit"),
    previousCommit: text("previous_commit"),
    manifest: json("manifest").$type<PluginManifest>().notNull(),
    previousManifest: json("previous_manifest").$type<PluginManifest>(),
    revision: integer("revision").notNull().default(1),
    installedAt: timestamp("installed_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (t) => [
    check("plugin_installations_source_check", sql`${t.source} in ('builtin', 'git')`),
    check("plugin_installations_revision_check", sql`${t.revision} > 0`),
    check(
      "plugin_installations_commit_check",
      sql`(${t.source} = 'builtin' and ${t.commit} is null and ${t.repository} is null) or (${t.source} = 'git' and ${t.commit} ~ '^[a-f0-9]{40}$' and ${t.repository} is not null)`,
    ),
  ],
);

export const bots = pgTable("bots", {
  activePromptVersionId: uuid("active_prompt_version_id"),
  id: uuid("id").defaultRandom().primaryKey(),
  name: text("name").notNull(),
  platform: text("platform").notNull().default("telegram"),
  encryptedToken: text("encrypted_token").notNull(),
  adminChatIds: json("admin_chat_ids").$type<number[]>().notNull().default([]),
  aiConfig: json("ai_config").$type<AiConfigStored>(),
  // Retained for existing installations. Retired integration data is excluded from Bot exports.
  larkWebhookConfig: json("lark_webhook_config"),
  emailForwardConfig: json("email_forward_config"),
  cosInsideConfig: json("cos_inside_config").$type<CosInsideConfig>(),
  isActive: boolean("is_active").notNull().default(true),
  miniAppEnabled: boolean("mini_app_enabled").notNull().default(false),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at")
    .defaultNow()
    .$onUpdate(() => new Date()),
});

export const mediaTranscriptionJobs = pgTable(
  "media_transcription_jobs",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    botId: uuid("bot_id")
      .notNull()
      .references(() => bots.id, { onDelete: "cascade" }),
    chatId: bigint("chat_id", { mode: "number" }).notNull(),
    userId: bigint("user_id", { mode: "number" }).notNull(),
    threadId: integer("thread_id"),
    confirmation: json("confirmation").$type<MediaJobConfirmation>(),
    confirmedAt: timestamp("confirmed_at"),
    providerTaskId: text("provider_task_id"),
    providerSubmittedAt: timestamp("provider_submitted_at"),
    providerAccount: text("provider_account").notNull().default("legacy"),
    providerRevision: integer("provider_revision").notNull().default(1),
    forceAsr: boolean("force_asr").notNull().default(false),
    pluginId: text("plugin_id").notNull().default("hanori.bilibili"),
    configRevision: integer("config_revision").notNull(),
    installationRevision: integer("installation_revision").notNull(),
    sourceUrl: text("source_url").notNull(),
    bvid: text("bvid").notNull(),
    part: integer("part").notNull(),
    title: text("title").notNull(),
    durationSeconds: integer("duration_seconds").notNull(),
    providerModel: text("provider_model").notNull(),
    estimatedCost: numeric("estimated_cost", {
      precision: 20,
      scale: 12,
      mode: "number",
    }).notNull(),
    status: text("status").$type<MediaJobStatus>().notNull().default("pending_confirmation"),
    progress: integer("progress").notNull().default(0),
    error: text("error"),
    result: json("result").$type<TranscriptDocument>(),
    cancelRequested: boolean("cancel_requested").notNull().default(false),
    cleanupPending: boolean("cleanup_pending").notNull().default(false),
    leaseId: uuid("lease_id"),
    leaseExpiresAt: timestamp("lease_expires_at"),
    attempt: integer("attempt").notNull().default(0),
    notification: text("notification")
      .$type<"pending" | "delivering" | "sent" | "failed">()
      .notNull()
      .default("pending"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
    expiresAt: timestamp("expires_at").notNull(),
  },
  (t) => [
    index("media_transcription_jobs_queue_idx").on(t.status, t.createdAt),
    index("media_transcription_jobs_actor_idx").on(t.botId, t.userId, t.createdAt),
    check(
      "media_transcription_jobs_status_check",
      sql`${t.status} in ('pending_confirmation','expired','queued','downloading','converting','transcribing','completed','failed','cancelled')`,
    ),
    check(
      "media_transcription_jobs_limits_check",
      sql`${t.durationSeconds} > 0 and ${t.part} >= 1 and ${t.part} <= 1000 and ${t.progress} >= 0 and ${t.progress} <= 100 and ${t.attempt} >= 0 and ${t.attempt} <= 2`,
    ),
  ],
);

export const videoDownloadJobs = pgTable(
  "video_download_jobs",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    botId: uuid("bot_id")
      .notNull()
      .references(() => bots.id, { onDelete: "cascade" }),
    chatId: bigint("chat_id", { mode: "number" }).notNull(),
    userId: bigint("user_id", { mode: "number" }).notNull(),
    threadId: integer("thread_id"),
    configRevision: integer("config_revision").notNull(),
    installationRevision: integer("installation_revision").notNull(),
    sourceUrl: text("source_url").notNull(),
    provider: text("provider").$type<"bilibili" | "ytdlp">().notNull().default("bilibili"),
    // Existing Bilibili IDs remain intact; yt-dlp stores [extractor, id] as a JSON tuple.
    bvid: text("bvid").notNull(),
    part: integer("part").notNull(),
    title: text("title").notNull(),
    durationSeconds: integer("duration_seconds"),
    status: text("status").$type<VideoDownloadStatus>().notNull().default("queued"),
    error: text("error"),
    bytes: integer("bytes"),
    messageId: integer("message_id"),
    cancelRequested: boolean("cancel_requested").notNull().default(false),
    cleanupPending: boolean("cleanup_pending").notNull().default(false),
    cacheExpiresAt: timestamp("cache_expires_at"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (t) => [
    index("video_download_jobs_queue_idx").on(t.status, t.createdAt),
    index("video_download_jobs_actor_idx").on(t.botId, t.userId, t.createdAt),
    check(
      "video_download_jobs_status_check",
      sql`${t.status} in ('queued','downloading','merging','sending','completed','failed','cancelled','delivery_unknown')`,
    ),
    check(
      "video_download_jobs_limits_check",
      sql`${t.durationSeconds}>0 and ${t.part} between 1 and 1000 and (${t.bytes} is null or ${t.bytes} between 1 and 50000000)`,
    ),
  ],
);

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

export const botPluginConfigs = pgTable(
  "bot_plugin_configs",
  {
    botId: uuid("bot_id")
      .notNull()
      .references(() => bots.id, { onDelete: "cascade" }),
    pluginId: text("plugin_id").notNull(),
    manifestVersion: text("manifest_version").notNull(),
    manifestHash: text("manifest_hash").notNull(),
    values: json("values").$type<PluginConfiguration>().notNull().default({}),
    encryptedSecrets: json("encrypted_secrets")
      .$type<Record<string, string>>()
      .notNull()
      .default({}),
    // Desired state; the runtime reports whether this revision was successfully applied.
    enabled: boolean("enabled").notNull().default(false),
    revision: integer("revision").notNull().default(1),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.botId, t.pluginId] }),
    check("bot_plugin_configs_revision_check", sql`${t.revision} > 0`),
    check("bot_plugin_configs_manifest_hash_check", sql`${t.manifestHash} ~ '^[a-f0-9]{64}$'`),
    check(
      "bot_plugin_configs_plugin_id_check",
      sql`length(${t.pluginId}) <= 100 and ${t.pluginId} ~ '^[a-z][a-z0-9]*([.-][a-z0-9]+)+$'`,
    ),
  ],
);

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

export const engagementSamples = pgTable(
  "engagement_samples",
  {
    id: serial("id").primaryKey(),
    botId: uuid("bot_id")
      .references(() => bots.id, { onDelete: "cascade" })
      .notNull(),
    chatId: bigint("chat_id", { mode: "number" }).notNull(),
    messageId: bigint("message_id", { mode: "number" }).notNull(),
    source: text("source").notNull(),
    mode: text("mode").notNull(),
    style: text("style").notNull(),
    choice: text("choice"),
    engagement: text("engagement").notNull(),
    confidence: real("confidence"),
    participation: json("participation").$type<EngagementParticipationDecision>(),
    probabilities: json("probabilities").$type<Record<string, number>>(),
    reasonCode: text("reason_code").notNull(),
    actualTrigger: text("actual_trigger"),
    model: text("model").notNull(),
    configVersion: text("config_version").notNull(),
    configSnapshot: json("config_snapshot").$type<EngagementPolicy>().notNull(),
    latencyMs: integer("latency_ms").notNull(),
    inputTokens: integer("input_tokens"),
    estimatedCostUsd: real("estimated_cost_usd"),
    inputPriceUsdPerMillion: real("input_price_usd_per_million").notNull(),
    pricingSource: text("pricing_source").notNull(),
    pricingSourceUrl: text("pricing_source_url").notNull(),
    pricingObservedAt: timestamp("pricing_observed_at").notNull(),
    context: json("context").$type<EngagementContextMessage[]>(),
    contextExpiresAt: timestamp("context_expires_at").notNull(),
    contextPurgedAt: timestamp("context_purged_at"),
    errorCategory: text("error_category"),
    label: text("label").$type<EngagementLabel>(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (t) => [
    index("engagement_samples_bot_created_idx").on(t.botId, t.createdAt),
    index("engagement_samples_bot_chat_created_idx").on(t.botId, t.chatId, t.createdAt),
    index("engagement_samples_context_expiry_idx").on(t.contextExpiresAt),
    check("engagement_samples_mode_check", sql`${t.mode} in ('off', 'shadow', 'active')`),
    check("engagement_samples_source_check", sql`${t.source} in ('jev', 'jev_error', 'local')`),
    check("engagement_samples_style_check", sql`${t.style} in ('natural', 'assistant', 'filter')`),
    check(
      "engagement_samples_choice_check",
      sql`${t.choice} is null or ${t.choice} in ('continue', 'join', 'silent')`,
    ),
    check("engagement_samples_engagement_check", sql`${t.engagement} in ('answer', 'silent')`),
    check(
      "engagement_samples_confidence_check",
      sql`${t.confidence} is null or (${t.confidence} >= 0 and ${t.confidence} <= 1)`,
    ),
    check("engagement_samples_latency_check", sql`${t.latencyMs} >= 0`),
    check(
      "engagement_samples_input_tokens_check",
      sql`${t.inputTokens} is null or ${t.inputTokens} >= 0`,
    ),
    check(
      "engagement_samples_estimated_cost_check",
      sql`${t.estimatedCostUsd} is null or ${t.estimatedCostUsd} >= 0`,
    ),
    check(
      "engagement_samples_label_check",
      sql`${t.label} is null or ${t.label} in ('answer', 'silent', 'uncertain')`,
    ),
  ],
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

export const generationCharacters = pgTable(
  "generation_characters",
  {
    id: serial("id").primaryKey(),
    botId: uuid("bot_id")
      .notNull()
      .references(() => bots.id, { onDelete: "cascade" }),
    source: text("source").$type<CharacterSource>().notNull(),
    canonicalTag: text("canonical_tag"),
    name: text("name").notNull(),
    aliases: json("aliases").$type<string[]>().notNull().default([]),
    appearance: text("appearance").notNull().default(""),
    defaultOutfit: text("default_outfit").notNull().default(""),
    notes: text("notes").notNull().default(""),
    copyright: text("copyright"),
    ownerTelegramId: bigint("owner_telegram_id", { mode: "number" }),
    postCount: integer("post_count"),
    wikiSummary: text("wiki_summary"),
    sourceUrl: text("source_url"),
    sourceFetchedAt: timestamp("source_fetched_at"),
    queryCount: integer("query_count").notNull().default(0),
    firstQueriedAt: timestamp("first_queried_at"),
    lastQueriedAt: timestamp("last_queried_at"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("generation_characters_bot_source_tag_idx").on(t.botId, t.source, t.canonicalTag),
    uniqueIndex("generation_characters_bot_id_idx").on(t.botId, t.id),
    index("generation_characters_bot_owner_idx").on(t.botId, t.ownerTelegramId),
    check(
      "generation_character_source_check",
      sql`(${t.source} = 'original' AND ${t.canonicalTag} IS NULL) OR (${t.source} = 'danbooru' AND ${t.canonicalTag} IS NOT NULL)`,
    ),
  ],
);

export const peopleCharacterBindings = pgTable(
  "people_character_bindings",
  {
    botId: uuid("bot_id")
      .notNull()
      .references(() => bots.id, { onDelete: "cascade" }),
    profileId: integer("profile_id")
      .notNull()
      .references(() => peopleProfiles.id, { onDelete: "cascade" }),
    characterId: integer("character_id").notNull(),
    relation: text("relation").$type<CharacterRelation>().notNull(),
    isDefault: boolean("is_default").notNull().default(false),
  },
  (t) => [
    primaryKey({ columns: [t.botId, t.profileId, t.characterId, t.relation] }),
    foreignKey({
      columns: [t.botId, t.characterId],
      foreignColumns: [generationCharacters.botId, generationCharacters.id],
    }).onDelete("cascade"),
    uniqueIndex("people_character_default_idx")
      .on(t.botId, t.profileId)
      .where(sql`${t.isDefault} = true`),
    check(
      "people_character_relation_check",
      sql`${t.relation} IN ('representation', 'favorite') AND (NOT ${t.isDefault} OR ${t.relation} = 'representation')`,
    ),
  ],
);

export const generationLibraryConfigs = pgTable("generation_library_configs", {
  botId: uuid("bot_id")
    .primaryKey()
    .references(() => bots.id, { onDelete: "cascade" }),
  settings: json("settings").$type<GenerationLibrarySettings>().notNull(),
});

export const promptAssets = pgTable(
  "prompt_assets",
  {
    id: serial("id").primaryKey(),
    botId: uuid("bot_id")
      .notNull()
      .references(() => bots.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    type: text("type").$type<PromptAssetType>().notNull(),
    content: text("content").notNull(),
    notes: text("notes").notNull().default(""),
    safety: text("safety").$type<AssetSafety>().notNull(),
    pinned: boolean("pinned").notNull().default(false),
    useCount: integer("use_count").notNull().default(0),
    lastUsedAt: timestamp("last_used_at"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (t) => [
    index("prompt_assets_bot_type_idx").on(t.botId, t.type),
    check("prompt_assets_safety_check", sql`${t.safety} IN ('safe', 'nsfw')`),
    check(
      "prompt_assets_type_check",
      sql`${t.type} IN ('artist_string', 'style', 'outfit', 'trait', 'composition')`,
    ),
  ],
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
    kind: text("kind").$type<"fact" | "preference" | "event" | "commitment" | "relationship">(),
    scopeChatId: bigint("scope_chat_id", { mode: "number" }),
    origin: text("origin"),
    sourceChatId: bigint("source_chat_id", { mode: "number" }),
    sourceMessageId: bigint("source_message_id", { mode: "number" }),
    sourceUserId: bigint("source_user_id", { mode: "number" }),
    expiresAt: timestamp("expires_at"),
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

export const memoryConsolidationState = pgTable("memory_consolidation_state", {
  botId: uuid("bot_id")
    .primaryKey()
    .references(() => bots.id, { onDelete: "cascade" }),
  cursorMessageId: integer("cursor_message_id").notNull().default(0),
  leaseOwner: uuid("lease_owner"),
  leaseUntil: timestamp("lease_until"),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

export const memoryConsolidationEvidence = pgTable(
  "memory_consolidation_evidence",
  {
    id: serial("id").primaryKey(),
    botId: uuid("bot_id")
      .notNull()
      .references(() => bots.id, { onDelete: "cascade" }),
    chatId: bigint("chat_id", { mode: "number" }).notNull(),
    action: text("action").$type<"add" | "update" | "retire" | "ignore">().notNull(),
    memoryId: integer("memory_id").references(() => botMemories.id, { onDelete: "set null" }),
    sourceMessageIds: integer("source_message_ids").array().notNull(),
    participantIds: bigint("participant_ids", { mode: "number" }).array().notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (t) => [
    index("memory_consolidation_evidence_bot_chat_idx").on(t.botId, t.chatId),
    index("memory_consolidation_evidence_memory_idx").on(t.memoryId),
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
      sql`${t.chatId} <> 0 and ${t.chatId} between -9007199254740991 and 9007199254740991`,
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
    filesPurgedAt: timestamp("files_purged_at"),
  },
  (t) => [
    index("pixai_gen_bot_id_idx").on(t.botId),
    index("pixai_gen_bot_chat_idx").on(t.botId, t.chatId),
    index("pixai_gen_created_idx").on(t.createdAt),
  ],
);

/** New provider-neutral image operations. pixai_generations remains read-only legacy history. */
export const imageGenerations = pgTable(
  "image_generations",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    botId: uuid("bot_id")
      .references(() => bots.id, { onDelete: "cascade" })
      .notNull(),
    chatId: bigint("chat_id", { mode: "number" }).notNull(),
    userId: bigint("user_id", { mode: "number" }).notNull(),
    provider: text("provider").notNull(),
    purpose: text("purpose").notNull(),
    presetKey: text("preset_key"),
    idempotencyKey: text("idempotency_key").notNull(),
    providerOperationId: text("provider_operation_id"),
    state: text("state").notNull().default("preparing"),
    providerState: text("provider_state"),
    approvalState: text("approval_state").notNull().default("not_required"),
    prompt: text("prompt").notNull(),
    negativePrompt: text("negative_prompt"),
    seed: bigint("seed", { mode: "number" }),
    providerMetadata: json("provider_metadata").$type<Record<string, unknown>>(),
    requestSnapshot: json("request_snapshot").$type<ImageGenerationRequestSnapshot>(),
    artifacts: json("artifacts").$type<ImageArtifact[]>().notNull().default([]),
    localFiles: json("local_files").$type<string[]>().notNull().default([]),
    deliveryMessageIds: json("delivery_message_ids").$type<number[]>().notNull().default([]),
    usageReservationId: uuid("usage_reservation_id"),
    errorCode: text("error_code"),
    errorMessage: text("error_message"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at")
      .defaultNow()
      .$onUpdate(() => new Date())
      .notNull(),
    completedAt: timestamp("completed_at"),
    deliveryClaimedAt: timestamp("delivery_claimed_at"),
    deliveredAt: timestamp("delivered_at"),
    filesPurgedAt: timestamp("files_purged_at"),
  },
  (t) => [
    uniqueIndex("image_generations_idempotency_uniq").on(t.idempotencyKey),
    uniqueIndex("image_generations_provider_operation_uniq").on(t.provider, t.providerOperationId),
    index("image_generations_bot_chat_idx").on(t.botId, t.chatId, t.createdAt),
    index("image_generations_recovery_idx").on(t.state, t.updatedAt),
    check(
      "image_generations_provider_check",
      sql`${t.provider} in ('mcp_pixai', 'mcp_openai', 'mcp_gemini', 'general_backend')`,
    ),
    check(
      "image_generations_purpose_check",
      sql`${t.purpose} in ('anime_illustration', 'general_image')`,
    ),
    check(
      "image_generations_state_check",
      sql`${t.state} in ('preparing', 'awaiting_approval', 'queued', 'running', 'succeeded', 'failed', 'waiting_stopped', 'cancel_rejected', 'cancel_requested', 'attention_required', 'cancelled')`,
    ),
    check(
      "image_generations_approval_check",
      sql`${t.approvalState} in ('not_required', 'required', 'approved', 'rejected')`,
    ),
  ],
);

/** Kept independently of the asset so deleting an asset cannot resurrect its usage. */
export const generationAssetUses = pgTable(
  "generation_asset_uses",
  {
    generationId: uuid("generation_id")
      .notNull()
      .references(() => imageGenerations.id, { onDelete: "cascade" }),
    assetId: integer("asset_id").notNull(),
    botId: uuid("bot_id")
      .notNull()
      .references(() => bots.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.generationId, t.assetId] })],
);

/** Append-only lifecycle history for provider-neutral image operations. */
export const imageGenerationEvents = pgTable(
  "image_generation_events",
  {
    id: serial("id").primaryKey(),
    generationId: uuid("generation_id")
      .references(() => imageGenerations.id, { onDelete: "cascade" })
      .notNull(),
    botId: uuid("bot_id")
      .references(() => bots.id, { onDelete: "cascade" })
      .notNull(),
    kind: text("kind").$type<ImageGenerationEventKind>().notNull(),
    state: text("state"),
    providerState: text("provider_state"),
    metadata: json("metadata").$type<Record<string, unknown>>(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (t) => [
    index("image_generation_events_generation_idx").on(t.generationId, t.createdAt),
    index("image_generation_events_bot_idx").on(t.botId, t.createdAt),
    check(
      "image_generation_events_kind_check",
      sql`${t.kind} in ('created', 'planned', 'submitted', 'state_changed', 'artifacts_saved', 'delivery_started', 'delivered', 'delivery_failed', 'cancel_requested', 'cancel_resolved', 'failed')`,
    ),
  ],
);

export const imageGenerationConfigs = pgTable("image_generation_configs", {
  botId: uuid("bot_id")
    .primaryKey()
    .references(() => bots.id, { onDelete: "cascade" }),
  config: json("config").$type<ImageGovernanceConfig>().notNull(),
  updatedAt: timestamp("updated_at")
    .defaultNow()
    .$onUpdate(() => new Date())
    .notNull(),
});

/** Singleton instance-wide OAuth grant. encryptedState contains tokens, DCR data and PKCE state. */
export const pixaiMcpConnections = pgTable("pixai_mcp_connections", {
  id: text("id").primaryKey().default("default"),
  encryptedState: text("encrypted_state"),
  status: text("status").notNull().default("disconnected"),
  grantedScopes: json("granted_scopes").$type<string[]>().notNull().default([]),
  ownerUserId: text("owner_user_id"),
  authorizationExpiresAt: timestamp("authorization_expires_at"),
  lastErrorCode: text("last_error_code"),
  connectedAt: timestamp("connected_at"),
  updatedAt: timestamp("updated_at")
    .defaultNow()
    .$onUpdate(() => new Date())
    .notNull(),
});

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
    cacheReadTokens: integer("cache_read_tokens"),
    cacheWriteTokens: integer("cache_write_tokens"),
    providerId: text("provider_id"),
    staticPrefixHash: text("static_prefix_hash"),
    toolSchemaHash: text("tool_schema_hash"),
    cacheFingerprint: text("cache_fingerprint"),
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

export const usageGovernancePolicies = pgTable(
  "usage_governance_policies",
  {
    botId: uuid("bot_id")
      .references(() => bots.id, { onDelete: "cascade" })
      .notNull(),
    resource: text("resource").notNull(),
    scope: text("scope").notNull(),
    subjectKey: text("subject_key").notNull(),
    limits: json("limits").$type<UsageLimits>().notNull(),
    updatedByKind: text("updated_by_kind").notNull().default("system"),
    updatedById: text("updated_by_id"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at")
      .defaultNow()
      .$onUpdate(() => new Date())
      .notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.botId, t.resource, t.scope, t.subjectKey] }),
    index("usage_policies_bot_resource_idx").on(t.botId, t.resource),
    check(
      "usage_policies_resource_check",
      sql`${t.resource} in ('ai_reply', 'image', 'proactive_reply')`,
    ),
    check(
      "usage_policies_scope_check",
      sql`${t.scope} in ('bot', 'chat', 'user_global', 'chat_user')`,
    ),
    check("usage_policies_subject_check", sql`length(btrim(${t.subjectKey})) > 0`),
    check(
      "usage_policies_actor_kind_check",
      sql`${t.updatedByKind} in ('owner', 'group_admin', 'system')`,
    ),
  ],
);

export const usageGovernanceReservations = pgTable(
  "usage_governance_reservations",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    botId: uuid("bot_id")
      .references(() => bots.id, { onDelete: "cascade" })
      .notNull(),
    resource: text("resource").notNull(),
    chatKind: text("chat_kind").notNull(),
    chatId: bigint("chat_id", { mode: "number" }),
    userId: bigint("user_id", { mode: "number" }),
    reservedUnits: integer("reserved_units").notNull(),
    settledUnits: integer("settled_units"),
    status: text("status").notNull().default("reserved"),
    bucketCharges: json("bucket_charges").$type<UsageBucketCharge[]>().notNull().default([]),
    reservedAt: timestamp("reserved_at").defaultNow().notNull(),
    expiresAt: timestamp("expires_at").notNull(),
    settledAt: timestamp("settled_at"),
    refundedAt: timestamp("refunded_at"),
  },
  (t) => [
    index("usage_reservations_bot_resource_time_idx").on(t.botId, t.resource, t.reservedAt),
    index("usage_reservations_chat_time_idx").on(t.botId, t.resource, t.chatId, t.reservedAt),
    index("usage_reservations_user_time_idx").on(t.botId, t.resource, t.userId, t.reservedAt),
    index("usage_reservations_active_idx").on(t.botId, t.resource, t.status, t.expiresAt),
    check(
      "usage_reservations_resource_check",
      sql`${t.resource} in ('ai_reply', 'image', 'proactive_reply')`,
    ),
    check("usage_reservations_chat_kind_check", sql`${t.chatKind} in ('private', 'group')`),
    check(
      "usage_reservations_status_check",
      sql`${t.status} in ('reserved', 'settled', 'refunded')`,
    ),
    check("usage_reservations_units_check", sql`${t.reservedUnits} > 0`),
    check(
      "usage_reservations_settled_units_check",
      sql`${t.settledUnits} is null or (${t.settledUnits} >= 0 and ${t.settledUnits} <= ${t.reservedUnits})`,
    ),
    check(
      "usage_reservations_chat_id_check",
      sql`${t.chatId} is null or (${t.chatId} <> 0 and ${t.chatId} between -9007199254740991 and 9007199254740991)`,
    ),
    check(
      "usage_reservations_user_id_check",
      sql`${t.userId} is null or (${t.userId} > 0 and ${t.userId} <= 9007199254740991)`,
    ),
  ],
);

export const usageGovernanceBuckets = pgTable(
  "usage_governance_buckets",
  {
    botId: uuid("bot_id")
      .references(() => bots.id, { onDelete: "cascade" })
      .notNull(),
    resource: text("resource").notNull(),
    scope: text("scope").notNull(),
    subjectKey: text("subject_key").notNull(),
    window: text("window").notNull(),
    windowKey: text("window_key").notNull(),
    timezone: text("timezone").notNull(),
    usedUnits: integer("used_units").notNull().default(0),
    closesAt: timestamp("closes_at").notNull(),
    retentionUntil: timestamp("retention_until").notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (t) => [
    primaryKey({
      columns: [t.botId, t.resource, t.scope, t.subjectKey, t.window, t.windowKey, t.timezone],
    }),
    index("usage_buckets_retention_idx").on(t.retentionUntil),
    check(
      "usage_buckets_resource_check",
      sql`${t.resource} in ('ai_reply', 'image', 'proactive_reply')`,
    ),
    check(
      "usage_buckets_scope_check",
      sql`${t.scope} in ('bot', 'chat', 'user_global', 'chat_user')`,
    ),
    check("usage_buckets_window_check", sql`${t.window} in ('day', 'month')`),
    check("usage_buckets_used_check", sql`${t.usedUnits} >= 0`),
  ],
);

export const usageGovernanceEvents = pgTable(
  "usage_governance_events",
  {
    id: serial("id").primaryKey(),
    reservationId: uuid("reservation_id")
      .references(() => usageGovernanceReservations.id, { onDelete: "cascade" })
      .notNull(),
    botId: uuid("bot_id")
      .references(() => bots.id, { onDelete: "cascade" })
      .notNull(),
    resource: text("resource").notNull(),
    eventType: text("event_type").notNull(),
    units: integer("units").notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (t) => [
    index("usage_events_bot_created_idx").on(t.botId, t.createdAt),
    index("usage_events_reservation_idx").on(t.reservationId, t.createdAt),
    check(
      "usage_events_resource_check",
      sql`${t.resource} in ('ai_reply', 'image', 'proactive_reply')`,
    ),
    check("usage_events_type_check", sql`${t.eventType} in ('reserved', 'settled', 'refunded')`),
    check("usage_events_units_check", sql`${t.units} >= 0`),
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

// Global scheduling must not create per-chat overrides: their presence disables fallback.
export const globalSummaryScheduleClaims = pgTable(
  "global_summary_schedule_claims",
  {
    botId: uuid("bot_id")
      .references(() => bots.id, { onDelete: "cascade" })
      .notNull(),
    chatId: bigint("chat_id", { mode: "number" }).notNull(),
    lastScheduledAt: timestamp("last_scheduled_at").notNull(),
  },
  (t) => [primaryKey({ columns: [t.botId, t.chatId] })],
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

// Dev Harness: GitHub remains the durable task record; these tables hold bindings, approvals,
// and the audit trail. See docs/design/dev-harness.md §11.
export const harnessProjects = pgTable("harness_projects", {
  key: text("key").primaryKey(),
  repo: text("repo").notNull(),
  chatId: bigint("chat_id", { mode: "number" }),
  threadId: integer("thread_id"),
  topicError: text("topic_error"),
  installationId: bigint("installation_id", { mode: "number" }),
  defaultBranch: text("default_branch"),
  kind: text("kind"),
  policy: json("policy").$type<Record<string, unknown>>(),
  policySha: text("policy_sha"),
  policyError: text("policy_error"),
  policyFetchedAt: timestamp("policy_fetched_at"),
  // Non-null marks a project added from the panel; harness.yaml projects leave it null.
  binding: json("binding").$type<Record<string, unknown>>(),
  policyPatch: json("policy_patch").$type<Record<string, unknown>>(),
  inferredPolicy: json("inferred_policy").$type<Record<string, unknown>>(),
  // Panel override for the lead session; allowed for harness.yaml projects too.
  execution: json("execution").$type<Record<string, unknown>>(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

/** Panel-managed harness settings that sit above harness.yaml, e.g. `execution`. */
export const harnessSettings = pgTable("harness_settings", {
  key: text("key").primaryKey(),
  value: json("value").$type<Record<string, unknown>>().notNull(),
  actorId: bigint("actor_id", { mode: "number" }),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

export const harnessConfigOverrides = pgTable(
  "harness_config_overrides",
  {
    id: serial("id").primaryKey(),
    scope: text("scope").notNull(),
    path: text("path").notNull(),
    value: json("value").$type<unknown>(),
    actorId: bigint("actor_id", { mode: "number" }),
    expiresAt: timestamp("expires_at"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (t) => [uniqueIndex("harness_overrides_scope_path_unique").on(t.scope, t.path)],
);

export const harnessEvents = pgTable(
  "harness_events",
  {
    id: serial("id").primaryKey(),
    type: text("type").notNull(),
    projectKey: text("project_key"),
    requestId: uuid("request_id"),
    approvalId: text("approval_id"),
    actorId: bigint("actor_id", { mode: "number" }),
    deliveryId: text("delivery_id"),
    payload: json("payload").$type<Record<string, unknown>>(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex("harness_events_delivery_unique").on(t.deliveryId),
    index("harness_events_created_idx").on(t.createdAt),
    index("harness_events_project_created_idx").on(t.projectKey, t.createdAt),
    index("harness_events_request_idx").on(t.requestId),
  ],
);

export const harnessRequests = pgTable(
  "harness_requests",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    projectKey: text("project_key").notNull(),
    type: text("type").notNull(),
    state: text("state").notNull(),
    repo: text("repo").notNull(),
    issueNumber: integer("issue_number"),
    prNumber: integer("pr_number"),
    headSha: text("head_sha"),
    title: text("title"),
    riskTier: text("risk_tier"),
    summary: text("summary"),
    summaryKey: text("summary_key"),
    chatId: bigint("chat_id", { mode: "number" }),
    threadId: integer("thread_id"),
    cardMessageId: integer("card_message_id"),
    cardKind: text("card_kind"),
    cardImageUrl: text("card_image_url"),
    cardHash: text("card_hash"),
    detailsViewedSha: text("details_viewed_sha"),
    bodyEditedAt: timestamp("body_edited_at"),
    lastPushAt: timestamp("last_push_at"),
    createdBy: bigint("created_by", { mode: "number" }),
    ownerText: text("owner_text"),
    areas: json("areas").$type<string[]>(),
    fixRounds: integer("fix_rounds").notNull().default(0),
    lastFixSha: text("last_fix_sha"),
    stateReason: text("state_reason"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex("harness_requests_repo_pr_unique").on(t.repo, t.prNumber),
    index("harness_requests_repo_issue_idx").on(t.repo, t.issueNumber),
    index("harness_requests_card_idx").on(t.chatId, t.cardMessageId),
    index("harness_requests_project_state_idx").on(t.projectKey, t.state),
    index("harness_requests_repo_head_idx").on(t.repo, t.headSha),
  ],
);

export const harnessApprovals = pgTable(
  "harness_approvals",
  {
    id: text("id").primaryKey(),
    requestId: uuid("request_id")
      .references(() => harnessRequests.id, { onDelete: "cascade" })
      .notNull(),
    action: text("action").notNull(),
    repo: text("repo").notNull(),
    prNumber: integer("pr_number"),
    headSha: text("head_sha").notNull(),
    expiresAt: timestamp("expires_at").notNull(),
    consumedAt: timestamp("consumed_at"),
    consumedBy: bigint("consumed_by", { mode: "number" }),
    invalidatedAt: timestamp("invalidated_at"),
    invalidReason: text("invalid_reason"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (t) => [index("harness_approvals_request_idx").on(t.requestId, t.createdAt)],
);

export interface HarnessQuotaSnapshot {
  provider: string;
  windows: Array<{ span: string; label: string | null; usedPercent: number; expired: boolean }>;
}

// One execution attempt of a request on a machine. `starting` rows carry a lease so a crash
// between "create session" and "persist session id" is detected instead of silently retried.
export const harnessJobs = pgTable(
  "harness_jobs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    requestId: uuid("request_id")
      .references(() => harnessRequests.id, { onDelete: "cascade" })
      .notNull(),
    attempt: integer("attempt").notNull(),
    executor: text("executor").notNull(),
    state: text("state").notNull(),
    machineKey: text("machine_key").notNull(),
    lodyMachine: text("lody_machine").notNull(),
    provider: text("provider").notNull(),
    role: text("role").notNull(),
    agent: text("agent").notNull(),
    model: text("model"),
    sessionId: text("session_id"),
    leaseUntil: timestamp("lease_until"),
    sessionStatus: text("session_status"),
    modelName: text("model_name"),
    contextUsed: integer("context_used"),
    contextSize: integer("context_size"),
    quota: json("quota").$type<HarnessQuotaSnapshot>(),
    startedAt: timestamp("started_at"),
    lastActivityAt: timestamp("last_activity_at"),
    nextPollAt: timestamp("next_poll_at"),
    idleRemindedAt: timestamp("idle_reminded_at"),
    runRemindedAt: timestamp("run_reminded_at"),
    endedAt: timestamp("ended_at"),
    error: text("error"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex("harness_jobs_request_attempt_unique").on(t.requestId, t.attempt),
    index("harness_jobs_state_idx").on(t.state),
    index("harness_jobs_created_idx").on(t.createdAt),
  ],
);

// Telegram messages the owner may reply to or press buttons on, besides the request card.
export const harnessMessages = pgTable(
  "harness_messages",
  {
    id: serial("id").primaryKey(),
    chatId: bigint("chat_id", { mode: "number" }).notNull(),
    messageId: integer("message_id").notNull(),
    requestId: uuid("request_id")
      .references(() => harnessRequests.id, { onDelete: "cascade" })
      .notNull(),
    kind: text("kind").notNull(),
    ref: json("ref").$type<Record<string, unknown>>(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (t) => [uniqueIndex("harness_messages_chat_message_unique").on(t.chatId, t.messageId)],
);

export interface HarnessTopicSuggestion {
  command: string;
  args: string;
  /** Set when the suggestion targets another project than the topic's, e.g. from General. */
  project: string | null;
}

// The topic assistant's conversation: owner free text and the assistant's replies only. Commands,
// cards, and command replies never land here. Text is stored because the feature needs it; rows
// are pruned by age and per-topic count.
export const harnessTopicMessages = pgTable(
  "harness_topic_messages",
  {
    id: serial("id").primaryKey(),
    chatId: bigint("chat_id", { mode: "number" }).notNull(),
    // 0 is the General topic.
    threadId: integer("thread_id").notNull(),
    role: text("role").notNull(),
    text: text("text").notNull(),
    messageId: integer("message_id"),
    suggestions: json("suggestions").$type<HarnessTopicSuggestion[]>(),
    // Bit i is set once suggestion i was executed.
    suggestionsUsed: integer("suggestions_used").notNull().default(0),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (t) => [
    index("harness_topic_messages_topic_idx").on(t.chatId, t.threadId, t.id),
    index("harness_topic_messages_message_idx").on(t.chatId, t.messageId),
    index("harness_topic_messages_created_idx").on(t.createdAt),
  ],
);

export const scheduledTasks = pgTable(
  "scheduled_tasks",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    botId: uuid("bot_id")
      .notNull()
      .references(() => bots.id, { onDelete: "cascade" }),
    chatId: bigint("chat_id", { mode: "number" }).notNull(),
    threadId: integer("thread_id"),
    proposerId: bigint("proposer_id", { mode: "number" }).notNull(),
    proposerName: text("proposer_name").notNull(),
    approvedByUserId: bigint("approved_by_user_id", { mode: "number" }),
    activePlan: json("active_plan").$type<ScheduledTaskPlan>(),
    pendingPlan: json("pending_plan").$type<ScheduledTaskPlan>(),
    revision: integer("revision").notNull().default(0),
    pendingVersion: integer("pending_version"),
    lastTrialVersion: integer("last_trial_version"),
    expiresAt: timestamp("expires_at"),
    confirmationMessageId: bigint("confirmation_message_id", { mode: "number" }),
    status: text("status").notNull().default("pending"),
    nextRunAt: timestamp("next_run_at"),
    runningRunId: uuid("running_run_id"),
    consecutiveFailures: integer("consecutive_failures").notNull().default(0),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => [
    index("scheduled_tasks_due_idx").on(t.status, t.nextRunAt),
    index("scheduled_tasks_scope_idx").on(t.botId, t.chatId),
  ],
);

export const scheduledTaskRuns = pgTable(
  "scheduled_task_runs",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    taskId: uuid("task_id")
      .notNull()
      .references(() => scheduledTasks.id, { onDelete: "cascade" }),
    status: text("status").notNull(),
    trial: boolean("trial").notNull().default(false),
    manual: boolean("manual").notNull().default(false),
    messageIds: json("message_ids").$type<number[]>().notNull().default([]),
    scheduledFor: timestamp("scheduled_for").notNull(),
    startedAt: timestamp("started_at").notNull().defaultNow(),
    finishedAt: timestamp("finished_at"),
    plan: json("plan").$type<ScheduledTaskPlan>().notNull(),
    agent: json("agent").$type<AgentExecutionConfig>().notNull(),
    output: text("output"),
    error: text("error"),
  },
  (t) => [index("scheduled_task_runs_task_idx").on(t.taskId, t.startedAt)],
);

export const promptVersions = pgTable(
  "prompt_versions",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    botId: uuid("bot_id")
      .notNull()
      .references(() => bots.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    description: text("description").notNull().default(""),
    applicationVersion: text("application_version").notNull(),
    snapshot: json("snapshot").$type<PromptSnapshot>().notNull(),
    previews: json("previews")
      .$type<{ private: PromptPreviewSnapshot; group: PromptPreviewSnapshot }>()
      .notNull(),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (table) => [index("prompt_versions_bot_idx").on(table.botId, table.createdAt)],
);
