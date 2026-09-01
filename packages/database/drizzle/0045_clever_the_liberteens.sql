CREATE TABLE "image_generation_events" (
	"id" serial PRIMARY KEY NOT NULL,
	"generation_id" uuid NOT NULL,
	"bot_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"state" text,
	"provider_state" text,
	"metadata" json,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "image_generation_events_kind_check" CHECK ("image_generation_events"."kind" in ('created', 'planned', 'submitted', 'state_changed', 'artifacts_saved', 'delivery_started', 'delivered', 'delivery_failed', 'cancel_requested', 'cancel_resolved', 'failed'))
);
--> statement-breakpoint
ALTER TABLE "image_generations" ADD COLUMN "request_snapshot" json;--> statement-breakpoint
ALTER TABLE "image_generations" ADD COLUMN "files_purged_at" timestamp;--> statement-breakpoint
ALTER TABLE "pixai_generations" ADD COLUMN "files_purged_at" timestamp;--> statement-breakpoint
ALTER TABLE "image_generation_events" ADD CONSTRAINT "image_generation_events_generation_id_image_generations_id_fk" FOREIGN KEY ("generation_id") REFERENCES "public"."image_generations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "image_generation_events" ADD CONSTRAINT "image_generation_events_bot_id_bots_id_fk" FOREIGN KEY ("bot_id") REFERENCES "public"."bots"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "image_generation_events_generation_idx" ON "image_generation_events" USING btree ("generation_id","created_at");--> statement-breakpoint
CREATE INDEX "image_generation_events_bot_idx" ON "image_generation_events" USING btree ("bot_id","created_at");