UPDATE "bot_memories" SET "embedding" = NULL;--> statement-breakpoint
UPDATE "conversation_messages" SET "embedding" = NULL;--> statement-breakpoint
ALTER TABLE "bot_memories" ALTER COLUMN "embedding" SET DATA TYPE vector(3072);--> statement-breakpoint
ALTER TABLE "conversation_messages" ALTER COLUMN "embedding" SET DATA TYPE vector(3072);
