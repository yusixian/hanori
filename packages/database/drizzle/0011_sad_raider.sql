ALTER TABLE "bot_memories" ALTER COLUMN "embedding" SET DATA TYPE vector(768);--> statement-breakpoint
ALTER TABLE "conversation_messages" ALTER COLUMN "embedding" SET DATA TYPE vector(768);