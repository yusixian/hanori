ALTER TABLE "people_profiles" ADD COLUMN "first_name" text;--> statement-breakpoint
ALTER TABLE "people_profiles" ADD COLUMN "last_name" text;--> statement-breakpoint
ALTER TABLE "people_profiles" ADD COLUMN "language_code" text;--> statement-breakpoint
ALTER TABLE "people_profiles" ADD COLUMN "is_premium" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "people_profiles" ADD COLUMN "avatar_path" text;--> statement-breakpoint
ALTER TABLE "people_profiles" ADD COLUMN "avatar_version" text;