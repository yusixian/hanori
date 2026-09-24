CREATE TABLE "harness_jobs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"request_id" uuid NOT NULL,
	"attempt" integer NOT NULL,
	"executor" text NOT NULL,
	"state" text NOT NULL,
	"machine_key" text NOT NULL,
	"lody_machine" text NOT NULL,
	"provider" text NOT NULL,
	"role" text NOT NULL,
	"agent" text NOT NULL,
	"model" text,
	"session_id" text,
	"lease_until" timestamp,
	"session_status" text,
	"model_name" text,
	"context_used" integer,
	"context_size" integer,
	"quota" json,
	"started_at" timestamp,
	"last_activity_at" timestamp,
	"next_poll_at" timestamp,
	"idle_reminded_at" timestamp,
	"run_reminded_at" timestamp,
	"ended_at" timestamp,
	"error" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "harness_messages" (
	"id" serial PRIMARY KEY NOT NULL,
	"chat_id" bigint NOT NULL,
	"message_id" integer NOT NULL,
	"request_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"ref" json,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "harness_requests" ADD COLUMN "owner_text" text;--> statement-breakpoint
ALTER TABLE "harness_requests" ADD COLUMN "areas" json;--> statement-breakpoint
ALTER TABLE "harness_requests" ADD COLUMN "fix_rounds" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "harness_requests" ADD COLUMN "last_fix_sha" text;--> statement-breakpoint
ALTER TABLE "harness_requests" ADD COLUMN "state_reason" text;--> statement-breakpoint
ALTER TABLE "harness_jobs" ADD CONSTRAINT "harness_jobs_request_id_harness_requests_id_fk" FOREIGN KEY ("request_id") REFERENCES "public"."harness_requests"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "harness_messages" ADD CONSTRAINT "harness_messages_request_id_harness_requests_id_fk" FOREIGN KEY ("request_id") REFERENCES "public"."harness_requests"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "harness_jobs_request_attempt_unique" ON "harness_jobs" USING btree ("request_id","attempt");--> statement-breakpoint
CREATE INDEX "harness_jobs_state_idx" ON "harness_jobs" USING btree ("state");--> statement-breakpoint
CREATE INDEX "harness_jobs_created_idx" ON "harness_jobs" USING btree ("created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "harness_messages_chat_message_unique" ON "harness_messages" USING btree ("chat_id","message_id");--> statement-breakpoint
CREATE INDEX "harness_requests_repo_issue_idx" ON "harness_requests" USING btree ("repo","issue_number");--> statement-breakpoint
CREATE INDEX "harness_requests_card_idx" ON "harness_requests" USING btree ("chat_id","card_message_id");