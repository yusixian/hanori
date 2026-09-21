CREATE TABLE "generation_characters" (
	"id" serial PRIMARY KEY NOT NULL,
	"bot_id" uuid NOT NULL,
	"source" text NOT NULL,
	"canonical_tag" text,
	"name" text NOT NULL,
	"aliases" json DEFAULT '[]'::json NOT NULL,
	"appearance" text DEFAULT '' NOT NULL,
	"default_outfit" text DEFAULT '' NOT NULL,
	"notes" text DEFAULT '' NOT NULL,
	"copyright" text,
	"owner_telegram_id" bigint,
	"post_count" integer,
	"wiki_summary" text,
	"source_url" text,
	"source_fetched_at" timestamp,
	"query_count" integer DEFAULT 0 NOT NULL,
	"first_queried_at" timestamp,
	"last_queried_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "generation_character_source_check" CHECK (("generation_characters"."source" = 'original' AND "generation_characters"."canonical_tag" IS NULL) OR ("generation_characters"."source" = 'danbooru' AND "generation_characters"."canonical_tag" IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "people_character_bindings" (
	"bot_id" uuid NOT NULL,
	"profile_id" integer NOT NULL,
	"character_id" integer NOT NULL,
	"relation" text NOT NULL,
	"is_default" boolean DEFAULT false NOT NULL,
	CONSTRAINT "people_character_bindings_bot_id_profile_id_character_id_relation_pk" PRIMARY KEY("bot_id","profile_id","character_id","relation"),
	CONSTRAINT "people_character_relation_check" CHECK ("people_character_bindings"."relation" IN ('representation', 'favorite') AND (NOT "people_character_bindings"."is_default" OR "people_character_bindings"."relation" = 'representation'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX "generation_characters_bot_id_idx" ON "generation_characters" USING btree ("bot_id","id");--> statement-breakpoint
ALTER TABLE "generation_characters" ADD CONSTRAINT "generation_characters_bot_id_bots_id_fk" FOREIGN KEY ("bot_id") REFERENCES "public"."bots"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "people_character_bindings" ADD CONSTRAINT "people_character_bindings_bot_id_bots_id_fk" FOREIGN KEY ("bot_id") REFERENCES "public"."bots"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "people_character_bindings" ADD CONSTRAINT "people_character_bindings_profile_id_people_profiles_id_fk" FOREIGN KEY ("profile_id") REFERENCES "public"."people_profiles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "people_character_bindings" ADD CONSTRAINT "people_character_bindings_bot_id_character_id_generation_characters_bot_id_id_fk" FOREIGN KEY ("bot_id","character_id") REFERENCES "public"."generation_characters"("bot_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "generation_characters_bot_source_tag_idx" ON "generation_characters" USING btree ("bot_id","source","canonical_tag");--> statement-breakpoint
CREATE INDEX "generation_characters_bot_owner_idx" ON "generation_characters" USING btree ("bot_id","owner_telegram_id");--> statement-breakpoint
CREATE UNIQUE INDEX "people_character_default_idx" ON "people_character_bindings" USING btree ("bot_id","profile_id") WHERE "people_character_bindings"."is_default" = true;