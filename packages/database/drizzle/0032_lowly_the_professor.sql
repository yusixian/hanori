CREATE TABLE "user_privacy_settings" (
	"bot_id" uuid NOT NULL,
	"user_id" bigint NOT NULL,
	"mode" text DEFAULT 'normal' NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "user_privacy_settings_bot_id_user_id_pk" PRIMARY KEY("bot_id","user_id")
);
--> statement-breakpoint
ALTER TABLE "user_privacy_settings" ADD CONSTRAINT "user_privacy_settings_bot_id_bots_id_fk" FOREIGN KEY ("bot_id") REFERENCES "public"."bots"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "user_privacy_bot_mode_idx" ON "user_privacy_settings" USING btree ("bot_id","mode");--> statement-breakpoint
CREATE INDEX "conv_msg_bot_user_role_created_idx" ON "conversation_messages" USING btree ("bot_id","user_id","role","created_at","id");