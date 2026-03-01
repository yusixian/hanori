ALTER TABLE "bot_memories" ADD COLUMN "embedding" vector(1536);--> statement-breakpoint
ALTER TABLE "bot_memories" ADD COLUMN "fact_valid_at" timestamp;--> statement-breakpoint
ALTER TABLE "bot_memories" ADD COLUMN "superseded_by_id" integer;--> statement-breakpoint
ALTER TABLE "bot_memories" ADD COLUMN "is_active" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "conversation_messages" ADD COLUMN "embedding" vector(1536);--> statement-breakpoint
CREATE INDEX "bot_memories_bot_category_idx" ON "bot_memories" USING btree ("bot_id","category");--> statement-breakpoint
CREATE INDEX "bot_memories_embedding_idx" ON "bot_memories" USING hnsw ("embedding" vector_cosine_ops);--> statement-breakpoint
CREATE INDEX "conv_msg_embedding_idx" ON "conversation_messages" USING hnsw ("embedding" vector_cosine_ops);