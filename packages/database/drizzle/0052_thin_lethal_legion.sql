ALTER TABLE "bot_memories" ADD COLUMN "kind" text;--> statement-breakpoint
ALTER TABLE "bot_memories" ADD COLUMN "scope_chat_id" bigint;--> statement-breakpoint
ALTER TABLE "bot_memories" ADD COLUMN "origin" text;--> statement-breakpoint
ALTER TABLE "bot_memories" ADD COLUMN "source_chat_id" bigint;--> statement-breakpoint
ALTER TABLE "bot_memories" ADD COLUMN "source_message_id" bigint;--> statement-breakpoint
ALTER TABLE "bot_memories" ADD COLUMN "source_user_id" bigint;--> statement-breakpoint
ALTER TABLE "bot_memories" ADD COLUMN "expires_at" timestamp;