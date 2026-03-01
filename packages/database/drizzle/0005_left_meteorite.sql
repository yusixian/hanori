CREATE TABLE "people_profiles" (
	"id" serial PRIMARY KEY NOT NULL,
	"bot_id" uuid NOT NULL,
	"telegram_id" bigint NOT NULL,
	"username" text,
	"display_name" text,
	"notes" text,
	"traits" json DEFAULT '[]'::json,
	"interests" json DEFAULT '[]'::json,
	"relationship" text,
	"first_seen" timestamp DEFAULT now() NOT NULL,
	"last_seen" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now()
);
--> statement-breakpoint
ALTER TABLE "people_profiles" ADD CONSTRAINT "people_profiles_bot_id_bots_id_fk" FOREIGN KEY ("bot_id") REFERENCES "public"."bots"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "people_bot_telegram_idx" ON "people_profiles" USING btree ("bot_id","telegram_id");--> statement-breakpoint
CREATE EXTENSION IF NOT EXISTS pg_trgm;--> statement-breakpoint
CREATE INDEX "conv_msg_content_trgm_idx" ON "conversation_messages" USING GIN ("content" gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "people_notes_trgm_idx" ON "people_profiles" USING GIN ("notes" gin_trgm_ops);