ALTER TABLE "pixai_generations" ADD COLUMN "sampling_steps" integer;--> statement-breakpoint
ALTER TABLE "pixai_generations" ADD COLUMN "cfg_scale" real;--> statement-breakpoint
ALTER TABLE "pixai_generations" ADD COLUMN "prompt_helper" boolean;