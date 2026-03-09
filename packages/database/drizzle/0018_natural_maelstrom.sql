ALTER TABLE "bots" ADD COLUMN "platform" text DEFAULT 'telegram' NOT NULL;--> statement-breakpoint
ALTER TABLE "bots" ADD COLUMN "lark_webhook_config" json;--> statement-breakpoint
ALTER TABLE "bots" ADD COLUMN "email_forward_config" json;
