CREATE TABLE "generation_library_configs" (
	"bot_id" uuid PRIMARY KEY NOT NULL,
	"settings" json NOT NULL
);
--> statement-breakpoint
CREATE TABLE "prompt_assets" (
	"id" serial PRIMARY KEY NOT NULL,
	"bot_id" uuid NOT NULL,
	"name" text NOT NULL,
	"type" text NOT NULL,
	"content" text NOT NULL,
	"notes" text DEFAULT '' NOT NULL,
	"safety" text NOT NULL,
	"pinned" boolean DEFAULT false NOT NULL,
	"use_count" integer DEFAULT 0 NOT NULL,
	"last_used_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "prompt_assets_safety_check" CHECK ("prompt_assets"."safety" IN ('safe', 'nsfw')),
	CONSTRAINT "prompt_assets_type_check" CHECK ("prompt_assets"."type" IN ('artist_string', 'style', 'outfit', 'trait', 'composition'))
);
--> statement-breakpoint
ALTER TABLE "generation_library_configs" ADD CONSTRAINT "generation_library_configs_bot_id_bots_id_fk" FOREIGN KEY ("bot_id") REFERENCES "public"."bots"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "prompt_assets" ADD CONSTRAINT "prompt_assets_bot_id_bots_id_fk" FOREIGN KEY ("bot_id") REFERENCES "public"."bots"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "prompt_assets_bot_type_idx" ON "prompt_assets" USING btree ("bot_id","type");