import { boolean, index, json, pgTable, serial, text, timestamp, uuid } from "drizzle-orm/pg-core";

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
    level: text("level").notNull(), // 'info' | 'warn' | 'error'
    message: text("message").notNull(),
    meta: json("meta"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (t) => [index("bot_logs_bot_id_idx").on(t.botId)],
);
