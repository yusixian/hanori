CREATE TABLE "media_transcription_jobs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"bot_id" uuid NOT NULL,
	"chat_id" bigint NOT NULL,
	"user_id" bigint NOT NULL,
	"plugin_id" text DEFAULT 'hanori.bilibili' NOT NULL,
	"config_revision" integer NOT NULL,
	"installation_revision" integer NOT NULL,
	"source_url" text NOT NULL,
	"bvid" text NOT NULL,
	"part" integer NOT NULL,
	"title" text NOT NULL,
	"duration_seconds" integer NOT NULL,
	"provider_model" text NOT NULL,
	"estimated_cost" real NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"progress" integer DEFAULT 0 NOT NULL,
	"error" text,
	"result" json,
	"cancel_requested" boolean DEFAULT false NOT NULL,
	"lease_id" uuid,
	"lease_expires_at" timestamp,
	"attempt" integer DEFAULT 0 NOT NULL,
	"notification" text DEFAULT 'pending' NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"expires_at" timestamp NOT NULL,
	CONSTRAINT "media_transcription_jobs_status_check" CHECK ("media_transcription_jobs"."status" in ('queued','downloading','converting','transcribing','completed','failed','cancelled')),
	CONSTRAINT "media_transcription_jobs_limits_check" CHECK ("media_transcription_jobs"."duration_seconds" > 0 and "media_transcription_jobs"."duration_seconds" <= 600 and "media_transcription_jobs"."part" >= 1 and "media_transcription_jobs"."part" <= 1000 and "media_transcription_jobs"."progress" >= 0 and "media_transcription_jobs"."progress" <= 100 and "media_transcription_jobs"."attempt" >= 0 and "media_transcription_jobs"."attempt" <= 2)
);
--> statement-breakpoint
ALTER TABLE "media_transcription_jobs" ADD CONSTRAINT "media_transcription_jobs_bot_id_bots_id_fk" FOREIGN KEY ("bot_id") REFERENCES "public"."bots"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "media_transcription_jobs_queue_idx" ON "media_transcription_jobs" USING btree ("status","created_at");--> statement-breakpoint
CREATE INDEX "media_transcription_jobs_actor_idx" ON "media_transcription_jobs" USING btree ("bot_id","user_id","created_at");