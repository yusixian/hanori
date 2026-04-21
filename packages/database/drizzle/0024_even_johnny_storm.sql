CREATE TABLE "chat_summaries" (
	"id" serial PRIMARY KEY NOT NULL,
	"bot_id" uuid NOT NULL,
	"chat_id" bigint NOT NULL,
	"trigger" text NOT NULL,
	"triggered_by" bigint,
	"window_start" timestamp NOT NULL,
	"window_end" timestamp NOT NULL,
	"message_count" integer NOT NULL,
	"model_id" text NOT NULL,
	"content" text NOT NULL,
	"prompt_tokens" integer,
	"completion_tokens" integer,
	"duration_ms" integer,
	"error_message" text,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "summary_configs" (
	"id" serial PRIMARY KEY NOT NULL,
	"bot_id" uuid NOT NULL,
	"chat_id" bigint NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"schedule_hour" integer,
	"schedule_minute" integer,
	"window_hours" integer DEFAULT 24 NOT NULL,
	"custom_prompt" text,
	"model_id" text,
	"max_messages" integer,
	"cooldown_seconds" integer,
	"access_mode" text DEFAULT 'all' NOT NULL,
	"last_scheduled_at" timestamp,
	"last_manual_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now()
);
--> statement-breakpoint
ALTER TABLE "chat_summaries" ADD CONSTRAINT "chat_summaries_bot_id_bots_id_fk" FOREIGN KEY ("bot_id") REFERENCES "public"."bots"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "summary_configs" ADD CONSTRAINT "summary_configs_bot_id_bots_id_fk" FOREIGN KEY ("bot_id") REFERENCES "public"."bots"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "chat_summaries_bot_chat_idx" ON "chat_summaries" USING btree ("bot_id","chat_id");--> statement-breakpoint
CREATE INDEX "chat_summaries_created_idx" ON "chat_summaries" USING btree ("created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "summary_configs_bot_chat_uniq" ON "summary_configs" USING btree ("bot_id","chat_id");