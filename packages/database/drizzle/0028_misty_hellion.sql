CREATE TABLE "bot_run_events" (
	"id" serial PRIMARY KEY NOT NULL,
	"run_id" uuid NOT NULL,
	"sequence" integer NOT NULL,
	"kind" text NOT NULL,
	"level" text DEFAULT 'info' NOT NULL,
	"data" json NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "bot_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"bot_id" uuid NOT NULL,
	"source" text NOT NULL,
	"channel" text NOT NULL,
	"mode" text DEFAULT 'dry-run' NOT NULL,
	"status" text DEFAULT 'running' NOT NULL,
	"failure_reason" text,
	"input" json NOT NULL,
	"config_snapshot" json,
	"duration_ms" integer,
	"pinned" boolean DEFAULT false NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"completed_at" timestamp
);
--> statement-breakpoint
ALTER TABLE "bot_logs" ADD COLUMN "bot_run_id" uuid;--> statement-breakpoint
ALTER TABLE "bot_run_events" ADD CONSTRAINT "bot_run_events_run_id_bot_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."bot_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bot_runs" ADD CONSTRAINT "bot_runs_bot_id_bots_id_fk" FOREIGN KEY ("bot_id") REFERENCES "public"."bots"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "bot_run_events_run_sequence_idx" ON "bot_run_events" USING btree ("run_id","sequence");--> statement-breakpoint
CREATE INDEX "bot_run_events_run_idx" ON "bot_run_events" USING btree ("run_id");--> statement-breakpoint
CREATE INDEX "bot_runs_bot_created_idx" ON "bot_runs" USING btree ("bot_id","created_at");