CREATE TABLE "conversation_compaction_state" (
	"bot_id" uuid NOT NULL,
	"chat_id" bigint NOT NULL,
	"active_summary_id" integer NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "conversation_compaction_state_bot_id_chat_id_pk" PRIMARY KEY("bot_id","chat_id")
);
--> statement-breakpoint
DROP INDEX "conv_msg_bot_chat_idx";--> statement-breakpoint
ALTER TABLE "conversation_summaries" ADD COLUMN "previous_summarized_up_to_id" integer;--> statement-breakpoint
ALTER TABLE "conversation_compaction_state" ADD CONSTRAINT "conversation_compaction_state_bot_id_bots_id_fk" FOREIGN KEY ("bot_id") REFERENCES "public"."bots"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversation_compaction_state" ADD CONSTRAINT "conversation_compaction_state_active_summary_id_conversation_summaries_id_fk" FOREIGN KEY ("active_summary_id") REFERENCES "public"."conversation_summaries"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
INSERT INTO "conversation_compaction_state" ("bot_id", "chat_id", "active_summary_id")
SELECT DISTINCT ON ("bot_id", "chat_id") "bot_id", "chat_id", "id"
FROM "conversation_summaries"
ORDER BY "bot_id", "chat_id", "id" DESC;--> statement-breakpoint
CREATE INDEX "conv_compaction_active_summary_idx" ON "conversation_compaction_state" USING btree ("active_summary_id");--> statement-breakpoint
CREATE INDEX "conv_msg_bot_chat_idx" ON "conversation_messages" USING btree ("bot_id","chat_id","id");
