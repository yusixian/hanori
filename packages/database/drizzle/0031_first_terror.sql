ALTER TABLE "people_profiles" ADD COLUMN "first_name" text;--> statement-breakpoint
ALTER TABLE "people_profiles" ADD COLUMN "last_name" text;--> statement-breakpoint
ALTER TABLE "people_profiles" ADD COLUMN "language_code" text;--> statement-breakpoint
ALTER TABLE "people_profiles" ADD COLUMN "is_premium" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "people_profiles" ADD COLUMN "avatar_path" text;--> statement-breakpoint
ALTER TABLE "people_profiles" ADD COLUMN "avatar_version" text;--> statement-breakpoint
WITH "duplicate_groups" AS (
	SELECT
		"bot_id",
		"telegram_id",
		(array_agg("id" ORDER BY "last_seen" DESC, "id" DESC))[1] AS "survivor_id",
		MIN("first_seen") AS "first_seen",
		MAX("last_seen") AS "last_seen",
		MAX("updated_at") AS "updated_at"
	FROM "people_profiles"
	GROUP BY "bot_id", "telegram_id"
	HAVING COUNT(*) > 1
),
"merged" AS (
	SELECT
		"groups".*,
		(
			SELECT "profile"."username"
			FROM "people_profiles" AS "profile"
			WHERE "profile"."bot_id" = "groups"."bot_id"
				AND "profile"."telegram_id" = "groups"."telegram_id"
				AND "profile"."username" IS NOT NULL
			ORDER BY "profile"."last_seen" DESC, "profile"."id" DESC
			LIMIT 1
		) AS "username",
		(
			SELECT "profile"."display_name"
			FROM "people_profiles" AS "profile"
			WHERE "profile"."bot_id" = "groups"."bot_id"
				AND "profile"."telegram_id" = "groups"."telegram_id"
				AND "profile"."display_name" IS NOT NULL
			ORDER BY "profile"."last_seen" DESC, "profile"."id" DESC
			LIMIT 1
		) AS "display_name",
		(
			SELECT "profile"."first_name"
			FROM "people_profiles" AS "profile"
			WHERE "profile"."bot_id" = "groups"."bot_id"
				AND "profile"."telegram_id" = "groups"."telegram_id"
				AND "profile"."first_name" IS NOT NULL
			ORDER BY "profile"."last_seen" DESC, "profile"."id" DESC
			LIMIT 1
		) AS "first_name",
		(
			SELECT "profile"."last_name"
			FROM "people_profiles" AS "profile"
			WHERE "profile"."bot_id" = "groups"."bot_id"
				AND "profile"."telegram_id" = "groups"."telegram_id"
				AND "profile"."last_name" IS NOT NULL
			ORDER BY "profile"."last_seen" DESC, "profile"."id" DESC
			LIMIT 1
		) AS "last_name",
		(
			SELECT "profile"."language_code"
			FROM "people_profiles" AS "profile"
			WHERE "profile"."bot_id" = "groups"."bot_id"
				AND "profile"."telegram_id" = "groups"."telegram_id"
				AND "profile"."language_code" IS NOT NULL
			ORDER BY "profile"."last_seen" DESC, "profile"."id" DESC
			LIMIT 1
		) AS "language_code",
		(
			SELECT "profile"."is_premium"
			FROM "people_profiles" AS "profile"
			WHERE "profile"."bot_id" = "groups"."bot_id"
				AND "profile"."telegram_id" = "groups"."telegram_id"
			ORDER BY "profile"."last_seen" DESC, "profile"."id" DESC
			LIMIT 1
		) AS "is_premium",
		(
			SELECT "profile"."relationship"
			FROM "people_profiles" AS "profile"
			WHERE "profile"."bot_id" = "groups"."bot_id"
				AND "profile"."telegram_id" = "groups"."telegram_id"
				AND "profile"."relationship" IS NOT NULL
			ORDER BY "profile"."last_seen" DESC, "profile"."id" DESC
			LIMIT 1
		) AS "relationship",
		(
			SELECT string_agg("notes"."note", E'\n' ORDER BY "notes"."first_seen", "notes"."id")
			FROM (
				SELECT DISTINCT ON ("profile"."notes")
					"profile"."notes" AS "note",
					"profile"."first_seen",
					"profile"."id"
				FROM "people_profiles" AS "profile"
				WHERE "profile"."bot_id" = "groups"."bot_id"
					AND "profile"."telegram_id" = "groups"."telegram_id"
					AND NULLIF(BTRIM("profile"."notes"), '') IS NOT NULL
				ORDER BY "profile"."notes", "profile"."first_seen", "profile"."id"
			) AS "notes"
		) AS "notes",
		(
			SELECT COALESCE(json_agg("trait"."value" ORDER BY "trait"."value"), '[]'::json)
			FROM (
				SELECT DISTINCT "item"."value"
				FROM "people_profiles" AS "profile"
				CROSS JOIN LATERAL json_array_elements_text(COALESCE("profile"."traits", '[]'::json)) AS "item"("value")
				WHERE "profile"."bot_id" = "groups"."bot_id"
					AND "profile"."telegram_id" = "groups"."telegram_id"
			) AS "trait"
		) AS "traits",
		(
			SELECT COALESCE(json_agg("interest"."value" ORDER BY "interest"."value"), '[]'::json)
			FROM (
				SELECT DISTINCT "item"."value"
				FROM "people_profiles" AS "profile"
				CROSS JOIN LATERAL json_array_elements_text(COALESCE("profile"."interests", '[]'::json)) AS "item"("value")
				WHERE "profile"."bot_id" = "groups"."bot_id"
					AND "profile"."telegram_id" = "groups"."telegram_id"
			) AS "interest"
		) AS "interests"
	FROM "duplicate_groups" AS "groups"
)
UPDATE "people_profiles" AS "survivor"
SET
	"username" = "merged"."username",
	"display_name" = "merged"."display_name",
	"first_name" = "merged"."first_name",
	"last_name" = "merged"."last_name",
	"language_code" = "merged"."language_code",
	"is_premium" = "merged"."is_premium",
	"relationship" = "merged"."relationship",
	"notes" = "merged"."notes",
	"traits" = "merged"."traits",
	"interests" = "merged"."interests",
	"first_seen" = "merged"."first_seen",
	"last_seen" = "merged"."last_seen",
	"updated_at" = "merged"."updated_at"
FROM "merged"
WHERE "survivor"."id" = "merged"."survivor_id";--> statement-breakpoint
WITH "survivors" AS (
	SELECT
		"bot_id",
		"telegram_id",
		(array_agg("id" ORDER BY "last_seen" DESC, "id" DESC))[1] AS "survivor_id"
	FROM "people_profiles"
	GROUP BY "bot_id", "telegram_id"
	HAVING COUNT(*) > 1
)
DELETE FROM "people_profiles" AS "duplicate"
USING "survivors"
WHERE "duplicate"."bot_id" = "survivors"."bot_id"
	AND "duplicate"."telegram_id" = "survivors"."telegram_id"
	AND "duplicate"."id" <> "survivors"."survivor_id";--> statement-breakpoint
DROP INDEX "people_bot_telegram_idx";--> statement-breakpoint
CREATE UNIQUE INDEX "people_bot_telegram_idx" ON "people_profiles" USING btree ("bot_id","telegram_id");
