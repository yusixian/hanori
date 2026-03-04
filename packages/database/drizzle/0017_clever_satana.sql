CREATE TABLE "timers" (
	"id" text PRIMARY KEY NOT NULL,
	"bot_id" uuid,
	"type" text NOT NULL,
	"name" text NOT NULL,
	"chat_id" bigint,
	"status" text DEFAULT 'active' NOT NULL,
	"interval_ms" integer,
	"fires_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"fired_at" timestamp,
	"meta" json
);
--> statement-breakpoint
ALTER TABLE "timers" ADD CONSTRAINT "timers_bot_id_bots_id_fk" FOREIGN KEY ("bot_id") REFERENCES "public"."bots"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "timers_bot_id_idx" ON "timers" USING btree ("bot_id");--> statement-breakpoint
CREATE INDEX "timers_status_idx" ON "timers" USING btree ("status");
