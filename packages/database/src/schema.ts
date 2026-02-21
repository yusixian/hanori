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
  uuid,
} from "drizzle-orm/pg-core";

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
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (t) => [
    index("conv_msg_bot_chat_idx").on(t.botId, t.chatId),
    index("conv_msg_created_idx").on(t.createdAt),
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
