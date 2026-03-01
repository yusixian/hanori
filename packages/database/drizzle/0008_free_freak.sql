CREATE TABLE "backups" (
	"id" serial PRIMARY KEY NOT NULL,
	"filename" text NOT NULL,
	"size_bytes" integer NOT NULL,
	"duration_ms" integer NOT NULL,
	"remote_url" text,
	"remote_provider" text,
	"status" text NOT NULL,
	"error" text,
	"created_at" timestamp DEFAULT now() NOT NULL
);
