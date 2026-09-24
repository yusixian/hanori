CREATE TABLE "harness_approvals" (
	"id" text PRIMARY KEY NOT NULL,
	"request_id" uuid NOT NULL,
	"action" text NOT NULL,
	"repo" text NOT NULL,
	"pr_number" integer,
	"head_sha" text NOT NULL,
	"expires_at" timestamp NOT NULL,
	"consumed_at" timestamp,
	"consumed_by" bigint,
	"invalidated_at" timestamp,
	"invalid_reason" text,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "harness_config_overrides" (
	"id" serial PRIMARY KEY NOT NULL,
	"scope" text NOT NULL,
	"path" text NOT NULL,
	"value" json,
	"actor_id" bigint,
	"expires_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "harness_events" (
	"id" serial PRIMARY KEY NOT NULL,
	"type" text NOT NULL,
	"project_key" text,
	"request_id" uuid,
	"approval_id" text,
	"actor_id" bigint,
	"delivery_id" text,
	"payload" json,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "harness_projects" (
	"key" text PRIMARY KEY NOT NULL,
	"repo" text NOT NULL,
	"chat_id" bigint,
	"thread_id" integer,
	"topic_error" text,
	"installation_id" bigint,
	"default_branch" text,
	"kind" text,
	"policy" json,
	"policy_sha" text,
	"policy_error" text,
	"policy_fetched_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "harness_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_key" text NOT NULL,
	"type" text NOT NULL,
	"state" text NOT NULL,
	"repo" text NOT NULL,
	"issue_number" integer,
	"pr_number" integer,
	"head_sha" text,
	"title" text,
	"risk_tier" text,
	"summary" text,
	"summary_key" text,
	"chat_id" bigint,
	"thread_id" integer,
	"card_message_id" integer,
	"card_kind" text,
	"card_image_url" text,
	"card_hash" text,
	"details_viewed_sha" text,
	"body_edited_at" timestamp,
	"last_push_at" timestamp,
	"created_by" bigint,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "harness_approvals" ADD CONSTRAINT "harness_approvals_request_id_harness_requests_id_fk" FOREIGN KEY ("request_id") REFERENCES "public"."harness_requests"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "harness_approvals_request_idx" ON "harness_approvals" USING btree ("request_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "harness_overrides_scope_path_unique" ON "harness_config_overrides" USING btree ("scope","path");--> statement-breakpoint
CREATE UNIQUE INDEX "harness_events_delivery_unique" ON "harness_events" USING btree ("delivery_id");--> statement-breakpoint
CREATE INDEX "harness_events_created_idx" ON "harness_events" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "harness_events_project_created_idx" ON "harness_events" USING btree ("project_key","created_at");--> statement-breakpoint
CREATE INDEX "harness_events_request_idx" ON "harness_events" USING btree ("request_id");--> statement-breakpoint
CREATE UNIQUE INDEX "harness_requests_repo_pr_unique" ON "harness_requests" USING btree ("repo","pr_number");--> statement-breakpoint
CREATE INDEX "harness_requests_project_state_idx" ON "harness_requests" USING btree ("project_key","state");--> statement-breakpoint
CREATE INDEX "harness_requests_repo_head_idx" ON "harness_requests" USING btree ("repo","head_sha");