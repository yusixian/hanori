CREATE TABLE "mcp_servers" (
	"id" serial PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"transport" text DEFAULT 'sse' NOT NULL,
	"url" text NOT NULL,
	"encrypted_headers" text,
	"preset_id" text,
	"is_active" boolean DEFAULT true NOT NULL,
	"tool_name_prefix" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now()
);
