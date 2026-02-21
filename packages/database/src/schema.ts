import { json, pgTable, serial, text, timestamp } from "drizzle-orm/pg-core";

export const settings = pgTable("settings", {
  key: text("key").primaryKey(),
  value: text("value").notNull(),
  updatedAt: timestamp("updated_at")
    .defaultNow()
    .$onUpdate(() => new Date()),
});

export const botLogs = pgTable("bot_logs", {
  id: serial("id").primaryKey(),
  level: text("level").notNull(), // 'info' | 'warn' | 'error'
  message: text("message").notNull(),
  meta: json("meta"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});
