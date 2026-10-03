CREATE TABLE "video_download_jobs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"bot_id" uuid NOT NULL,
	"chat_id" bigint NOT NULL,
	"user_id" bigint NOT NULL,
	"thread_id" integer,
	"config_revision" integer NOT NULL,
	"installation_revision" integer NOT NULL,
	"source_url" text NOT NULL,
	"bvid" text NOT NULL,
	"part" integer NOT NULL,
	"title" text NOT NULL,
	"duration_seconds" integer NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"error" text,
	"bytes" integer,
	"message_id" integer,
	"cancel_requested" boolean DEFAULT false NOT NULL,
	"cache_expires_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "video_download_jobs_status_check" CHECK ("video_download_jobs"."status" in ('queued','downloading','merging','sending','completed','failed','cancelled','delivery_unknown')),
	CONSTRAINT "video_download_jobs_limits_check" CHECK ("video_download_jobs"."duration_seconds">0 and "video_download_jobs"."part" between 1 and 1000 and ("video_download_jobs"."bytes" is null or "video_download_jobs"."bytes" between 1 and 50000000))
);
--> statement-breakpoint
ALTER TABLE "video_download_jobs" ADD CONSTRAINT "video_download_jobs_bot_id_bots_id_fk" FOREIGN KEY ("bot_id") REFERENCES "public"."bots"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "video_download_jobs_queue_idx" ON "video_download_jobs" USING btree ("status","created_at");--> statement-breakpoint
CREATE INDEX "video_download_jobs_actor_idx" ON "video_download_jobs" USING btree ("bot_id","user_id","created_at");