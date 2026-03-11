DROP INDEX "bot_memories_embedding_idx";--> statement-breakpoint
DROP INDEX "conv_msg_embedding_idx";--> statement-breakpoint
-- Clear existing embeddings before type change (vector → halfvec cannot cast in-place)
UPDATE "bot_memories" SET "embedding" = NULL;--> statement-breakpoint
UPDATE "conversation_messages" SET "embedding" = NULL;--> statement-breakpoint
ALTER TABLE "bot_memories" ALTER COLUMN "embedding" SET DATA TYPE halfvec(3072);--> statement-breakpoint
ALTER TABLE "conversation_messages" ALTER COLUMN "embedding" SET DATA TYPE halfvec(3072);--> statement-breakpoint
CREATE INDEX "bot_memories_embedding_idx" ON "bot_memories" USING hnsw ("embedding" halfvec_cosine_ops);--> statement-breakpoint
CREATE INDEX "conv_msg_embedding_idx" ON "conversation_messages" USING hnsw ("embedding" halfvec_cosine_ops);
