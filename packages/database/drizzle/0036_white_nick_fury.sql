CREATE TABLE "mini_app_audit_events" (
	"id" serial PRIMARY KEY NOT NULL,
	"bot_id" uuid NOT NULL,
	"actor_telegram_user_id" bigint,
	"actor_role" text NOT NULL,
	"capability" text NOT NULL,
	"action" text NOT NULL,
	"resource_type" text NOT NULL,
	"resource_id" text NOT NULL,
	"previous_summary" json,
	"next_summary" json,
	"outcome" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "mini_app_audit_events_actor_id_check" CHECK ("mini_app_audit_events"."actor_telegram_user_id" is null or ("mini_app_audit_events"."actor_telegram_user_id" > 0 and "mini_app_audit_events"."actor_telegram_user_id" <= 9007199254740991)),
	CONSTRAINT "mini_app_audit_events_actor_role_check" CHECK ("mini_app_audit_events"."actor_role" in ('admin', 'operator', 'viewer', 'system')),
	CONSTRAINT "mini_app_audit_events_outcome_check" CHECK ("mini_app_audit_events"."outcome" in ('succeeded', 'failed', 'partial'))
);
--> statement-breakpoint
CREATE TABLE "mini_app_chat_grants" (
	"bot_id" uuid NOT NULL,
	"chat_id" bigint NOT NULL,
	"created_by" bigint NOT NULL,
	"note" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "mini_app_chat_grants_bot_id_chat_id_pk" PRIMARY KEY("bot_id","chat_id"),
	CONSTRAINT "mini_app_chat_grants_chat_id_check" CHECK ("mini_app_chat_grants"."chat_id" < 0 and "mini_app_chat_grants"."chat_id" >= -9007199254740991),
	CONSTRAINT "mini_app_chat_grants_creator_check" CHECK ("mini_app_chat_grants"."created_by" > 0 and "mini_app_chat_grants"."created_by" <= 9007199254740991)
);
--> statement-breakpoint
CREATE TABLE "mini_app_operator_grants" (
	"bot_id" uuid NOT NULL,
	"telegram_user_id" bigint NOT NULL,
	"created_by" bigint NOT NULL,
	"note" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "mini_app_operator_grants_bot_id_telegram_user_id_pk" PRIMARY KEY("bot_id","telegram_user_id"),
	CONSTRAINT "mini_app_operator_grants_user_id_check" CHECK ("mini_app_operator_grants"."telegram_user_id" > 0 and "mini_app_operator_grants"."telegram_user_id" <= 9007199254740991),
	CONSTRAINT "mini_app_operator_grants_creator_check" CHECK ("mini_app_operator_grants"."created_by" > 0 and "mini_app_operator_grants"."created_by" <= 9007199254740991)
);
--> statement-breakpoint
CREATE TABLE "telegram_bot_profiles" (
	"bot_id" uuid PRIMARY KEY NOT NULL,
	"telegram_user_id" bigint NOT NULL,
	"username" text NOT NULL,
	"display_name" text NOT NULL,
	"observed_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "telegram_bot_profiles_user_id_check" CHECK ("telegram_bot_profiles"."telegram_user_id" > 0 and "telegram_bot_profiles"."telegram_user_id" <= 9007199254740991)
);
--> statement-breakpoint
CREATE TABLE "telegram_chats" (
	"bot_id" uuid NOT NULL,
	"chat_id" bigint NOT NULL,
	"type" text NOT NULL,
	"title" text,
	"username" text,
	"bot_membership_status" text,
	"membership_observed_at" timestamp,
	"last_observed_at" timestamp DEFAULT now() NOT NULL,
	"left_at" timestamp,
	"migrated_to_chat_id" bigint,
	CONSTRAINT "telegram_chats_bot_id_chat_id_pk" PRIMARY KEY("bot_id","chat_id"),
	CONSTRAINT "telegram_chats_chat_id_check" CHECK ("telegram_chats"."chat_id" < 0 and "telegram_chats"."chat_id" >= -9007199254740991),
	CONSTRAINT "telegram_chats_type_check" CHECK ("telegram_chats"."type" in ('group', 'supergroup')),
	CONSTRAINT "telegram_chats_membership_status_check" CHECK ("telegram_chats"."bot_membership_status" is null or "telegram_chats"."bot_membership_status" in ('creator', 'administrator', 'member', 'restricted', 'left', 'kicked')),
	CONSTRAINT "telegram_chats_migrated_to_check" CHECK ("telegram_chats"."migrated_to_chat_id" is null or ("telegram_chats"."migrated_to_chat_id" < 0 and "telegram_chats"."migrated_to_chat_id" >= -9007199254740991 and "telegram_chats"."migrated_to_chat_id" <> "telegram_chats"."chat_id"))
);
--> statement-breakpoint
ALTER TABLE "mini_app_audit_events" ADD CONSTRAINT "mini_app_audit_events_bot_id_bots_id_fk" FOREIGN KEY ("bot_id") REFERENCES "public"."bots"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mini_app_chat_grants" ADD CONSTRAINT "mini_app_chat_grants_catalog_fk" FOREIGN KEY ("bot_id","chat_id") REFERENCES "public"."telegram_chats"("bot_id","chat_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mini_app_operator_grants" ADD CONSTRAINT "mini_app_operator_grants_bot_id_bots_id_fk" FOREIGN KEY ("bot_id") REFERENCES "public"."bots"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "telegram_bot_profiles" ADD CONSTRAINT "telegram_bot_profiles_bot_id_bots_id_fk" FOREIGN KEY ("bot_id") REFERENCES "public"."bots"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "telegram_chats" ADD CONSTRAINT "telegram_chats_bot_id_bots_id_fk" FOREIGN KEY ("bot_id") REFERENCES "public"."bots"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "telegram_chats" ADD CONSTRAINT "telegram_chats_migrated_to_fk" FOREIGN KEY ("bot_id","migrated_to_chat_id") REFERENCES "public"."telegram_chats"("bot_id","chat_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "mini_app_audit_events_bot_created_idx" ON "mini_app_audit_events" USING btree ("bot_id","created_at");--> statement-breakpoint
CREATE INDEX "mini_app_audit_events_bot_actor_idx" ON "mini_app_audit_events" USING btree ("bot_id","actor_telegram_user_id","created_at");--> statement-breakpoint
CREATE INDEX "mini_app_audit_events_bot_action_idx" ON "mini_app_audit_events" USING btree ("bot_id","action","created_at");--> statement-breakpoint
CREATE INDEX "mini_app_audit_events_bot_resource_idx" ON "mini_app_audit_events" USING btree ("bot_id","resource_type","resource_id","created_at");--> statement-breakpoint
CREATE INDEX "telegram_chats_bot_last_observed_idx" ON "telegram_chats" USING btree ("bot_id","last_observed_at");--> statement-breakpoint
CREATE INDEX "telegram_chats_bot_membership_idx" ON "telegram_chats" USING btree ("bot_id","bot_membership_status");