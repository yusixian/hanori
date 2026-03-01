CREATE TABLE "token_usage" (
	"id" serial PRIMARY KEY NOT NULL,
	"bot_id" uuid NOT NULL,
	"chat_id" bigint NOT NULL,
	"user_id" bigint,
	"model" text NOT NULL,
	"prompt_tokens" integer DEFAULT 0 NOT NULL,
	"completion_tokens" integer DEFAULT 0 NOT NULL,
	"total_tokens" integer DEFAULT 0 NOT NULL,
	"duration_ms" integer,
	"trigger" text,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "token_usage" ADD CONSTRAINT "token_usage_bot_id_bots_id_fk" FOREIGN KEY ("bot_id") REFERENCES "public"."bots"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "token_usage_bot_id_idx" ON "token_usage" USING btree ("bot_id");--> statement-breakpoint
CREATE INDEX "token_usage_created_at_idx" ON "token_usage" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "token_usage_bot_created_idx" ON "token_usage" USING btree ("bot_id","created_at");