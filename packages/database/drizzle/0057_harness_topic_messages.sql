CREATE TABLE "harness_topic_messages" (
	"id" serial PRIMARY KEY NOT NULL,
	"chat_id" bigint NOT NULL,
	"thread_id" integer NOT NULL,
	"role" text NOT NULL,
	"text" text NOT NULL,
	"message_id" integer,
	"suggestions" json,
	"suggestions_used" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "harness_topic_messages_topic_idx" ON "harness_topic_messages" USING btree ("chat_id","thread_id","id");--> statement-breakpoint
CREATE INDEX "harness_topic_messages_message_idx" ON "harness_topic_messages" USING btree ("chat_id","message_id");--> statement-breakpoint
CREATE INDEX "harness_topic_messages_created_idx" ON "harness_topic_messages" USING btree ("created_at");