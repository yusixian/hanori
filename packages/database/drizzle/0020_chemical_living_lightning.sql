CREATE TABLE "rss_collections" (
	"id" serial PRIMARY KEY NOT NULL,
	"bot_id" uuid NOT NULL,
	"chat_id" bigint NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"digest_prompt" text,
	"is_active" boolean DEFAULT true NOT NULL,
	"digest_hour" integer DEFAULT 9 NOT NULL,
	"digest_minute" integer DEFAULT 0 NOT NULL,
	"last_digest_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "rss_feeds" (
	"id" serial PRIMARY KEY NOT NULL,
	"collection_id" integer NOT NULL,
	"feed_url" text NOT NULL,
	"title" text NOT NULL,
	"last_fetch_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "rss_items" (
	"id" serial PRIMARY KEY NOT NULL,
	"feed_id" integer NOT NULL,
	"guid" text NOT NULL,
	"title" text NOT NULL,
	"link" text NOT NULL,
	"summary" text,
	"published_at" timestamp,
	"fetched_at" timestamp DEFAULT now() NOT NULL,
	"digested_at" timestamp
);
--> statement-breakpoint
ALTER TABLE "rss_collections" ADD CONSTRAINT "rss_collections_bot_id_bots_id_fk" FOREIGN KEY ("bot_id") REFERENCES "public"."bots"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rss_feeds" ADD CONSTRAINT "rss_feeds_collection_id_rss_collections_id_fk" FOREIGN KEY ("collection_id") REFERENCES "public"."rss_collections"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rss_items" ADD CONSTRAINT "rss_items_feed_id_rss_feeds_id_fk" FOREIGN KEY ("feed_id") REFERENCES "public"."rss_feeds"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "rss_collections_bot_chat_idx" ON "rss_collections" USING btree ("bot_id","chat_id");--> statement-breakpoint
CREATE UNIQUE INDEX "rss_feeds_collection_url_uniq" ON "rss_feeds" USING btree ("collection_id","feed_url");--> statement-breakpoint
CREATE UNIQUE INDEX "rss_items_feed_guid_uniq" ON "rss_items" USING btree ("feed_id","guid");--> statement-breakpoint
CREATE INDEX "rss_items_feed_digested_idx" ON "rss_items" USING btree ("feed_id","digested_at");
