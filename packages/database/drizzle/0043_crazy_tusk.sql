DO $$
BEGIN
	IF to_regclass('public.pixai_generations') IS NOT NULL
		AND EXISTS (SELECT 1 FROM "pixai_generations" WHERE "status" = 'pending') THEN
		RAISE EXCEPTION 'legacy PixAI pending generations must be resolved before migration';
	END IF;
END $$;
--> statement-breakpoint
CREATE TABLE "image_generation_configs" (
	"bot_id" uuid PRIMARY KEY NOT NULL,
	"config" json NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "image_generations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"bot_id" uuid NOT NULL,
	"chat_id" bigint NOT NULL,
	"user_id" bigint NOT NULL,
	"provider" text NOT NULL,
	"purpose" text NOT NULL,
	"preset_key" text,
	"idempotency_key" text NOT NULL,
	"provider_operation_id" text,
	"state" text DEFAULT 'preparing' NOT NULL,
	"provider_state" text,
	"approval_state" text DEFAULT 'not_required' NOT NULL,
	"prompt" text NOT NULL,
	"negative_prompt" text,
	"seed" bigint,
	"provider_metadata" json,
	"artifacts" json DEFAULT '[]'::json NOT NULL,
	"local_files" json DEFAULT '[]'::json NOT NULL,
	"delivery_message_ids" json DEFAULT '[]'::json NOT NULL,
	"usage_reservation_id" uuid,
	"error_code" text,
	"error_message" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"completed_at" timestamp,
	"delivery_claimed_at" timestamp,
	"delivered_at" timestamp,
	CONSTRAINT "image_generations_provider_check" CHECK ("image_generations"."provider" in ('mcp_pixai', 'general_backend')),
	CONSTRAINT "image_generations_purpose_check" CHECK ("image_generations"."purpose" in ('anime_illustration', 'general_image')),
	CONSTRAINT "image_generations_state_check" CHECK ("image_generations"."state" in ('preparing', 'awaiting_approval', 'queued', 'running', 'succeeded', 'failed', 'waiting_stopped', 'cancel_rejected', 'cancel_requested', 'cancelled')),
	CONSTRAINT "image_generations_approval_check" CHECK ("image_generations"."approval_state" in ('not_required', 'required', 'approved', 'rejected'))
);
--> statement-breakpoint
CREATE TABLE "pixai_mcp_connections" (
	"id" text PRIMARY KEY DEFAULT 'default' NOT NULL,
	"encrypted_state" text,
	"status" text DEFAULT 'disconnected' NOT NULL,
	"granted_scopes" json DEFAULT '[]'::json NOT NULL,
	"owner_user_id" text,
	"authorization_expires_at" timestamp,
	"last_error_code" text,
	"connected_at" timestamp,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "usage_governance_buckets" (
	"bot_id" uuid NOT NULL,
	"resource" text NOT NULL,
	"scope" text NOT NULL,
	"subject_key" text NOT NULL,
	"window" text NOT NULL,
	"window_key" text NOT NULL,
	"timezone" text NOT NULL,
	"used_units" integer DEFAULT 0 NOT NULL,
	"closes_at" timestamp NOT NULL,
	"retention_until" timestamp NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "usage_governance_buckets_bot_id_resource_scope_subject_key_window_window_key_timezone_pk" PRIMARY KEY("bot_id","resource","scope","subject_key","window","window_key","timezone"),
	CONSTRAINT "usage_buckets_resource_check" CHECK ("usage_governance_buckets"."resource" in ('ai_reply', 'image', 'proactive_reply')),
	CONSTRAINT "usage_buckets_scope_check" CHECK ("usage_governance_buckets"."scope" in ('bot', 'chat', 'user_global', 'chat_user')),
	CONSTRAINT "usage_buckets_window_check" CHECK ("usage_governance_buckets"."window" in ('day', 'month')),
	CONSTRAINT "usage_buckets_used_check" CHECK ("usage_governance_buckets"."used_units" >= 0)
);
--> statement-breakpoint
CREATE TABLE "usage_governance_events" (
	"id" serial PRIMARY KEY NOT NULL,
	"reservation_id" uuid NOT NULL,
	"bot_id" uuid NOT NULL,
	"resource" text NOT NULL,
	"event_type" text NOT NULL,
	"units" integer NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "usage_events_resource_check" CHECK ("usage_governance_events"."resource" in ('ai_reply', 'image', 'proactive_reply')),
	CONSTRAINT "usage_events_type_check" CHECK ("usage_governance_events"."event_type" in ('reserved', 'settled', 'refunded')),
	CONSTRAINT "usage_events_units_check" CHECK ("usage_governance_events"."units" >= 0)
);
--> statement-breakpoint
CREATE TABLE "usage_governance_policies" (
	"bot_id" uuid NOT NULL,
	"resource" text NOT NULL,
	"scope" text NOT NULL,
	"subject_key" text NOT NULL,
	"limits" json NOT NULL,
	"updated_by_kind" text DEFAULT 'system' NOT NULL,
	"updated_by_id" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "usage_governance_policies_bot_id_resource_scope_subject_key_pk" PRIMARY KEY("bot_id","resource","scope","subject_key"),
	CONSTRAINT "usage_policies_resource_check" CHECK ("usage_governance_policies"."resource" in ('ai_reply', 'image', 'proactive_reply')),
	CONSTRAINT "usage_policies_scope_check" CHECK ("usage_governance_policies"."scope" in ('bot', 'chat', 'user_global', 'chat_user')),
	CONSTRAINT "usage_policies_subject_check" CHECK (length(btrim("usage_governance_policies"."subject_key")) > 0),
	CONSTRAINT "usage_policies_actor_kind_check" CHECK ("usage_governance_policies"."updated_by_kind" in ('owner', 'group_admin', 'system'))
);
--> statement-breakpoint
CREATE TABLE "usage_governance_reservations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"bot_id" uuid NOT NULL,
	"resource" text NOT NULL,
	"chat_kind" text NOT NULL,
	"chat_id" bigint,
	"user_id" bigint,
	"reserved_units" integer NOT NULL,
	"settled_units" integer,
	"status" text DEFAULT 'reserved' NOT NULL,
	"bucket_charges" json DEFAULT '[]'::json NOT NULL,
	"reserved_at" timestamp DEFAULT now() NOT NULL,
	"expires_at" timestamp NOT NULL,
	"settled_at" timestamp,
	"refunded_at" timestamp,
	CONSTRAINT "usage_reservations_resource_check" CHECK ("usage_governance_reservations"."resource" in ('ai_reply', 'image', 'proactive_reply')),
	CONSTRAINT "usage_reservations_chat_kind_check" CHECK ("usage_governance_reservations"."chat_kind" in ('private', 'group')),
	CONSTRAINT "usage_reservations_status_check" CHECK ("usage_governance_reservations"."status" in ('reserved', 'settled', 'refunded')),
	CONSTRAINT "usage_reservations_units_check" CHECK ("usage_governance_reservations"."reserved_units" > 0),
	CONSTRAINT "usage_reservations_settled_units_check" CHECK ("usage_governance_reservations"."settled_units" is null or ("usage_governance_reservations"."settled_units" >= 0 and "usage_governance_reservations"."settled_units" <= "usage_governance_reservations"."reserved_units")),
	CONSTRAINT "usage_reservations_chat_id_check" CHECK ("usage_governance_reservations"."chat_id" is null or ("usage_governance_reservations"."chat_id" <> 0 and "usage_governance_reservations"."chat_id" between -9007199254740991 and 9007199254740991)),
	CONSTRAINT "usage_reservations_user_id_check" CHECK ("usage_governance_reservations"."user_id" is null or ("usage_governance_reservations"."user_id" > 0 and "usage_governance_reservations"."user_id" <= 9007199254740991))
);
--> statement-breakpoint
ALTER TABLE "image_generation_configs" ADD CONSTRAINT "image_generation_configs_bot_id_bots_id_fk" FOREIGN KEY ("bot_id") REFERENCES "public"."bots"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "image_generations" ADD CONSTRAINT "image_generations_bot_id_bots_id_fk" FOREIGN KEY ("bot_id") REFERENCES "public"."bots"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "usage_governance_buckets" ADD CONSTRAINT "usage_governance_buckets_bot_id_bots_id_fk" FOREIGN KEY ("bot_id") REFERENCES "public"."bots"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "usage_governance_events" ADD CONSTRAINT "usage_governance_events_reservation_id_usage_governance_reservations_id_fk" FOREIGN KEY ("reservation_id") REFERENCES "public"."usage_governance_reservations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "usage_governance_events" ADD CONSTRAINT "usage_governance_events_bot_id_bots_id_fk" FOREIGN KEY ("bot_id") REFERENCES "public"."bots"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "usage_governance_policies" ADD CONSTRAINT "usage_governance_policies_bot_id_bots_id_fk" FOREIGN KEY ("bot_id") REFERENCES "public"."bots"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "usage_governance_reservations" ADD CONSTRAINT "usage_governance_reservations_bot_id_bots_id_fk" FOREIGN KEY ("bot_id") REFERENCES "public"."bots"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "image_generations_idempotency_uniq" ON "image_generations" USING btree ("idempotency_key");--> statement-breakpoint
CREATE UNIQUE INDEX "image_generations_provider_operation_uniq" ON "image_generations" USING btree ("provider","provider_operation_id");--> statement-breakpoint
CREATE INDEX "image_generations_bot_chat_idx" ON "image_generations" USING btree ("bot_id","chat_id","created_at");--> statement-breakpoint
CREATE INDEX "image_generations_recovery_idx" ON "image_generations" USING btree ("state","updated_at");--> statement-breakpoint
CREATE INDEX "usage_buckets_retention_idx" ON "usage_governance_buckets" USING btree ("retention_until");--> statement-breakpoint
CREATE INDEX "usage_events_bot_created_idx" ON "usage_governance_events" USING btree ("bot_id","created_at");--> statement-breakpoint
CREATE INDEX "usage_events_reservation_idx" ON "usage_governance_events" USING btree ("reservation_id","created_at");--> statement-breakpoint
CREATE INDEX "usage_policies_bot_resource_idx" ON "usage_governance_policies" USING btree ("bot_id","resource");--> statement-breakpoint
CREATE INDEX "usage_reservations_bot_resource_time_idx" ON "usage_governance_reservations" USING btree ("bot_id","resource","reserved_at");--> statement-breakpoint
CREATE INDEX "usage_reservations_chat_time_idx" ON "usage_governance_reservations" USING btree ("bot_id","resource","chat_id","reserved_at");--> statement-breakpoint
CREATE INDEX "usage_reservations_user_time_idx" ON "usage_governance_reservations" USING btree ("bot_id","resource","user_id","reserved_at");--> statement-breakpoint
CREATE INDEX "usage_reservations_active_idx" ON "usage_governance_reservations" USING btree ("bot_id","resource","status","expires_at");
