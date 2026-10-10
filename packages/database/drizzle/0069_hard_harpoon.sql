CREATE TABLE "global_summary_schedule_claims" (
	"bot_id" uuid NOT NULL,
	"chat_id" bigint NOT NULL,
	"last_scheduled_at" timestamp NOT NULL,
	CONSTRAINT "global_summary_schedule_claims_bot_id_chat_id_pk" PRIMARY KEY("bot_id","chat_id")
);
--> statement-breakpoint
ALTER TABLE "global_summary_schedule_claims" ADD CONSTRAINT "global_summary_schedule_claims_bot_id_bots_id_fk" FOREIGN KEY ("bot_id") REFERENCES "public"."bots"("id") ON DELETE cascade ON UPDATE no action;