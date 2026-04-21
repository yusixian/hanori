CREATE TABLE "chat_provider_overrides" (
	"id" serial PRIMARY KEY NOT NULL,
	"bot_id" uuid NOT NULL,
	"chat_id" bigint NOT NULL,
	"provider_id" text NOT NULL,
	"updated_at" timestamp DEFAULT now()
);
--> statement-breakpoint
ALTER TABLE "chat_provider_overrides" ADD CONSTRAINT "chat_provider_overrides_bot_id_bots_id_fk" FOREIGN KEY ("bot_id") REFERENCES "public"."bots"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "chat_provider_bot_chat_uniq" ON "chat_provider_overrides" USING btree ("bot_id","chat_id");