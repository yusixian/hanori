CREATE TABLE "pixai_generations" (
	"id" serial PRIMARY KEY NOT NULL,
	"bot_id" uuid NOT NULL,
	"chat_id" bigint NOT NULL,
	"user_id" bigint,
	"task_id" text NOT NULL,
	"prompt" text NOT NULL,
	"negative_prompt" text,
	"model_id" text NOT NULL,
	"width" integer NOT NULL,
	"height" integer NOT NULL,
	"batch_size" integer DEFAULT 1 NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"media_urls" json,
	"media_ids" json,
	"local_files" json,
	"error_message" text,
	"duration_ms" integer,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"completed_at" timestamp
);
--> statement-breakpoint
ALTER TABLE "pixai_generations" ADD CONSTRAINT "pixai_generations_bot_id_bots_id_fk" FOREIGN KEY ("bot_id") REFERENCES "public"."bots"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "pixai_gen_bot_id_idx" ON "pixai_generations" USING btree ("bot_id");--> statement-breakpoint
CREATE INDEX "pixai_gen_bot_chat_idx" ON "pixai_generations" USING btree ("bot_id","chat_id");--> statement-breakpoint
CREATE INDEX "pixai_gen_created_idx" ON "pixai_generations" USING btree ("created_at");