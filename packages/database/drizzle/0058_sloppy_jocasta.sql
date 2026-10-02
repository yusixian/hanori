CREATE TABLE "bot_plugin_configs" (
	"bot_id" uuid NOT NULL,
	"plugin_id" text NOT NULL,
	"manifest_version" text NOT NULL,
	"manifest_hash" text NOT NULL,
	"values" json DEFAULT '{}'::json NOT NULL,
	"encrypted_secrets" json DEFAULT '{}'::json NOT NULL,
	"enabled" boolean DEFAULT false NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "bot_plugin_configs_bot_id_plugin_id_pk" PRIMARY KEY("bot_id","plugin_id"),
	CONSTRAINT "bot_plugin_configs_revision_check" CHECK ("bot_plugin_configs"."revision" > 0),
	CONSTRAINT "bot_plugin_configs_manifest_hash_check" CHECK ("bot_plugin_configs"."manifest_hash" ~ '^[a-f0-9]{64}$'),
	CONSTRAINT "bot_plugin_configs_plugin_id_check" CHECK (length("bot_plugin_configs"."plugin_id") <= 100 and "bot_plugin_configs"."plugin_id" ~ '^[a-z][a-z0-9]*([.-][a-z0-9]+)+$')
);
--> statement-breakpoint
ALTER TABLE "bot_plugin_configs" ADD CONSTRAINT "bot_plugin_configs_bot_id_bots_id_fk" FOREIGN KEY ("bot_id") REFERENCES "public"."bots"("id") ON DELETE cascade ON UPDATE no action;