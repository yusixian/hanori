CREATE TABLE "plugin_installations" (
	"id" text PRIMARY KEY NOT NULL,
	"source" text NOT NULL,
	"repository" text,
	"commit" text,
	"previous_commit" text,
	"manifest" json NOT NULL,
	"previous_manifest" json,
	"revision" integer DEFAULT 1 NOT NULL,
	"installed_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "plugin_installations_source_check" CHECK ("plugin_installations"."source" in ('builtin', 'git')),
	CONSTRAINT "plugin_installations_revision_check" CHECK ("plugin_installations"."revision" > 0),
	CONSTRAINT "plugin_installations_commit_check" CHECK (("plugin_installations"."source" = 'builtin' and "plugin_installations"."commit" is null and "plugin_installations"."repository" is null) or ("plugin_installations"."source" = 'git' and "plugin_installations"."commit" ~ '^[a-f0-9]{40}$' and "plugin_installations"."repository" is not null))
);
