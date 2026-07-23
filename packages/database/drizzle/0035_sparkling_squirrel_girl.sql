ALTER TABLE "conversation_compaction_state" ADD COLUMN "raw_history_intact" boolean DEFAULT true NOT NULL;--> statement-breakpoint
UPDATE "conversation_compaction_state" SET "raw_history_intact" = false;
