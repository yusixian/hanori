CREATE TABLE "scheduled_task_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"task_id" uuid NOT NULL,
	"status" text NOT NULL,
	"trial" boolean DEFAULT false NOT NULL,
	"scheduled_for" timestamp NOT NULL,
	"started_at" timestamp DEFAULT now() NOT NULL,
	"finished_at" timestamp,
	"plan" json NOT NULL,
	"agent" json NOT NULL,
	"output" text,
	"error" text
);
--> statement-breakpoint
CREATE TABLE "scheduled_tasks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"bot_id" uuid NOT NULL,
	"chat_id" bigint NOT NULL,
	"thread_id" integer,
	"proposer_id" bigint NOT NULL,
	"proposer_name" text NOT NULL,
	"active_plan" json,
	"pending_plan" json,
	"revision" integer DEFAULT 0 NOT NULL,
	"pending_version" integer,
	"last_trial_version" integer,
	"expires_at" timestamp,
	"confirmation_message_id" bigint,
	"status" text DEFAULT 'pending' NOT NULL,
	"next_run_at" timestamp,
	"running_run_id" uuid,
	"consecutive_failures" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "scheduled_task_runs" ADD CONSTRAINT "scheduled_task_runs_task_id_scheduled_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."scheduled_tasks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scheduled_tasks" ADD CONSTRAINT "scheduled_tasks_bot_id_bots_id_fk" FOREIGN KEY ("bot_id") REFERENCES "public"."bots"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "scheduled_task_runs_task_idx" ON "scheduled_task_runs" USING btree ("task_id","started_at");--> statement-breakpoint
CREATE INDEX "scheduled_tasks_due_idx" ON "scheduled_tasks" USING btree ("status","next_run_at");--> statement-breakpoint
CREATE INDEX "scheduled_tasks_scope_idx" ON "scheduled_tasks" USING btree ("bot_id","chat_id");