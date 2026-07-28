ALTER TABLE "token_usage" ADD COLUMN "provider_id" text;--> statement-breakpoint
ALTER TABLE "token_usage" ADD COLUMN "static_prefix_hash" text;--> statement-breakpoint
ALTER TABLE "token_usage" ADD COLUMN "tool_schema_hash" text;--> statement-breakpoint
ALTER TABLE "token_usage" ADD COLUMN "cache_fingerprint" text;