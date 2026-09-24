CREATE TABLE "harness_settings" (
	"key" text PRIMARY KEY NOT NULL,
	"value" json NOT NULL,
	"actor_id" bigint,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "harness_projects" ADD COLUMN "binding" json;--> statement-breakpoint
ALTER TABLE "harness_projects" ADD COLUMN "policy_patch" json;--> statement-breakpoint
ALTER TABLE "harness_projects" ADD COLUMN "inferred_policy" json;--> statement-breakpoint
ALTER TABLE "harness_projects" ADD COLUMN "execution" json;