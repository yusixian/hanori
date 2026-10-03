ALTER TABLE "media_transcription_jobs" DROP CONSTRAINT "media_transcription_jobs_status_check";--> statement-breakpoint
ALTER TABLE "media_transcription_jobs" ALTER COLUMN "status" SET DEFAULT 'pending_confirmation';--> statement-breakpoint
ALTER TABLE "media_transcription_jobs" ADD COLUMN "thread_id" integer;--> statement-breakpoint
ALTER TABLE "media_transcription_jobs" ADD COLUMN "confirmation" json;--> statement-breakpoint
ALTER TABLE "media_transcription_jobs" ADD COLUMN "confirmed_at" timestamp;--> statement-breakpoint
ALTER TABLE "media_transcription_jobs" ADD COLUMN "provider_task_id" text;--> statement-breakpoint
ALTER TABLE "media_transcription_jobs" ADD COLUMN "provider_submitted_at" timestamp;--> statement-breakpoint
ALTER TABLE "media_transcription_jobs" ADD COLUMN "provider_account" text DEFAULT 'legacy' NOT NULL;--> statement-breakpoint
ALTER TABLE "media_transcription_jobs" ADD COLUMN "provider_revision" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "media_transcription_jobs" ADD COLUMN "force_asr" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "media_transcription_jobs" ADD CONSTRAINT "media_transcription_jobs_status_check" CHECK ("media_transcription_jobs"."status" in ('pending_confirmation','expired','queued','downloading','converting','transcribing','completed','failed','cancelled'));--> statement-breakpoint
-- Old pre-submission jobs have no per-task consent. Require a new proposal after upgrading.
UPDATE "media_transcription_jobs" SET "status" = 'expired', "error" = 'confirmation_required', "cancel_requested" = true
WHERE "confirmed_at" IS NULL AND "status" IN ('queued','downloading','converting');
