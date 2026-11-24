ALTER TABLE "memory_consolidation_evidence" ADD COLUMN "review_version" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "memory_consolidation_state" ADD COLUMN "group_impressions_since" timestamp DEFAULT timezone('UTC', now()) NOT NULL;--> statement-breakpoint
ALTER TABLE "memory_consolidation_state" ADD COLUMN "last_scheduled_at" timestamp;--> statement-breakpoint
ALTER TABLE "memory_consolidation_state" ADD COLUMN "last_run" jsonb;