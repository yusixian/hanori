ALTER TABLE "chat_ai_selections" DROP CONSTRAINT "chat_ai_selections_chat_id_check";--> statement-breakpoint
ALTER TABLE "chat_ai_selections" ADD CONSTRAINT "chat_ai_selections_chat_id_check" CHECK ("chat_ai_selections"."chat_id" <> 0 and "chat_ai_selections"."chat_id" between -9007199254740991 and 9007199254740991);--> statement-breakpoint

-- Migration 0038 deliberately reported positive legacy IDs without inserting
-- them. Positive Telegram chat IDs are private conversations, so resolve those
-- reports against the current provider catalog and restore only valid choices.
WITH legacy AS (
	SELECT
		coalesce(provider.bot_id, model.bot_id) AS bot_id,
		coalesce(provider.chat_id, model.chat_id) AS chat_id,
		provider.provider_id AS legacy_provider_id,
		model.model_id AS legacy_model_id
	FROM "chat_provider_overrides" AS provider
	FULL OUTER JOIN "chat_model_overrides" AS model
		ON provider.bot_id = model.bot_id AND provider.chat_id = model.chat_id
	WHERE coalesce(provider.chat_id, model.chat_id) > 0
		AND coalesce(provider.chat_id, model.chat_id) <= 9007199254740991
), catalog AS (
	SELECT
		legacy.*,
		bots.ai_config::jsonb AS ai_config,
		CASE
			WHEN bots.ai_config IS NULL THEN '[]'::jsonb
			WHEN jsonb_typeof(bots.ai_config::jsonb -> 'providers') = 'array'
				AND jsonb_array_length(bots.ai_config::jsonb -> 'providers') > 0
				THEN bots.ai_config::jsonb -> 'providers'
			ELSE jsonb_build_array(jsonb_build_object(
				'id', '__legacy__',
				'defaultModel', coalesce(bots.ai_config::jsonb ->> 'model', ''),
				'models', CASE
					WHEN jsonb_typeof(bots.ai_config::jsonb -> 'models') = 'array'
						THEN bots.ai_config::jsonb -> 'models'
					ELSE '[]'::jsonb
				END
			))
		END AS providers
	FROM legacy
	INNER JOIN "bots" ON bots.id = legacy.bot_id
), effective AS (
	SELECT
		catalog.*,
		CASE
			WHEN jsonb_array_length(catalog.providers) = 0 THEN NULL
			WHEN nullif(btrim(catalog.ai_config ->> 'activeProviderId'), '') IS NOT NULL
				AND EXISTS (
					SELECT 1
					FROM jsonb_array_elements(catalog.providers) AS candidate(value)
					WHERE btrim(candidate.value ->> 'id') = btrim(catalog.ai_config ->> 'activeProviderId')
				)
				THEN btrim(catalog.ai_config ->> 'activeProviderId')
			ELSE nullif(btrim(catalog.providers -> 0 ->> 'id'), '')
		END AS effective_provider_id
	FROM catalog
), resolved AS (
	SELECT
		effective.*,
		explicit_provider.value AS explicit_provider,
		effective_provider.value AS effective_provider
	FROM effective
	LEFT JOIN LATERAL (
		SELECT candidate.value
		FROM jsonb_array_elements(effective.providers) AS candidate(value)
		WHERE btrim(candidate.value ->> 'id') = btrim(effective.legacy_provider_id)
		LIMIT 1
	) AS explicit_provider ON true
	LEFT JOIN LATERAL (
		SELECT candidate.value
		FROM jsonb_array_elements(effective.providers) AS candidate(value)
		WHERE btrim(candidate.value ->> 'id') = effective.effective_provider_id
		LIMIT 1
	) AS effective_provider ON true
), evaluated AS (
	SELECT
		resolved.*,
		nullif(btrim(resolved.legacy_provider_id), '') IS NOT NULL AS has_legacy_provider,
		nullif(btrim(resolved.legacy_model_id), '') IS NOT NULL AS has_legacy_model,
		resolved.explicit_provider IS NOT NULL
			AND nullif(btrim(resolved.explicit_provider ->> 'id'), '') IS NOT NULL
			AS explicit_provider_valid,
		resolved.effective_provider IS NOT NULL
			AND nullif(btrim(resolved.effective_provider ->> 'id'), '') IS NOT NULL
			AS effective_provider_valid,
		nullif(btrim(resolved.legacy_model_id), '') IS NOT NULL AND resolved.explicit_provider IS NOT NULL AND (
			btrim(coalesce(resolved.explicit_provider ->> 'defaultModel', '')) = btrim(resolved.legacy_model_id)
			OR EXISTS (
				SELECT 1 FROM jsonb_array_elements(
					CASE
						WHEN jsonb_typeof(resolved.explicit_provider -> 'models') = 'array'
							THEN resolved.explicit_provider -> 'models'
						ELSE '[]'::jsonb
					END
				) AS model(value)
				WHERE btrim(model.value ->> 'id') = btrim(resolved.legacy_model_id)
			)
		) AS explicit_model_valid,
		nullif(btrim(resolved.legacy_model_id), '') IS NOT NULL AND resolved.effective_provider IS NOT NULL AND (
			btrim(coalesce(resolved.effective_provider ->> 'defaultModel', '')) = btrim(resolved.legacy_model_id)
			OR EXISTS (
				SELECT 1 FROM jsonb_array_elements(
					CASE
						WHEN jsonb_typeof(resolved.effective_provider -> 'models') = 'array'
							THEN resolved.effective_provider -> 'models'
						ELSE '[]'::jsonb
					END
				) AS model(value)
				WHERE btrim(model.value ->> 'id') = btrim(resolved.legacy_model_id)
			)
		) AS effective_model_valid
	FROM resolved
)
INSERT INTO "chat_ai_selection_migration_reports" (
	"bot_id", "chat_id", "legacy_provider_id", "legacy_model_id", "effective_provider_id",
	"selected_provider_id", "selected_model_id", "outcome", "reason"
)
SELECT
	bot_id,
	chat_id,
	legacy_provider_id,
	legacy_model_id,
	CASE WHEN effective_provider_valid THEN effective_provider_id ELSE NULL END,
	CASE
		WHEN has_legacy_provider AND NOT has_legacy_model AND explicit_provider_valid
			THEN btrim(explicit_provider ->> 'id')
		WHEN NOT has_legacy_provider AND has_legacy_model AND effective_model_valid
			THEN effective_provider_id
		WHEN has_legacy_provider AND has_legacy_model AND explicit_provider_valid
			THEN btrim(explicit_provider ->> 'id')
		ELSE NULL
	END,
	CASE
		WHEN NOT has_legacy_provider AND has_legacy_model AND effective_model_valid
			THEN btrim(legacy_model_id)
		WHEN has_legacy_provider AND has_legacy_model AND explicit_model_valid
			THEN btrim(legacy_model_id)
		ELSE NULL
	END,
	CASE
		WHEN has_legacy_provider AND NOT has_legacy_model AND explicit_provider_valid
			THEN 'migrated_provider_default'
		WHEN NOT has_legacy_provider AND has_legacy_model AND effective_model_valid
			THEN 'migrated_pair'
		WHEN has_legacy_provider AND has_legacy_model AND explicit_model_valid
			THEN 'migrated_pair'
		WHEN has_legacy_provider AND has_legacy_model AND explicit_provider_valid
			THEN 'migrated_provider_default'
		ELSE 'inherited'
	END,
	CASE
		WHEN has_legacy_provider AND NOT has_legacy_model AND explicit_provider_valid
			THEN 'provider_only_valid'
		WHEN has_legacy_provider AND NOT has_legacy_model
			THEN 'provider_only_invalid_provider'
		WHEN NOT has_legacy_provider AND has_legacy_model AND NOT effective_provider_valid
			THEN 'model_only_no_effective_provider'
		WHEN NOT has_legacy_provider AND has_legacy_model AND effective_model_valid
			THEN 'model_only_valid'
		WHEN NOT has_legacy_provider AND has_legacy_model
			THEN 'model_only_invalid_model'
		WHEN has_legacy_provider AND has_legacy_model AND NOT explicit_provider_valid
			THEN 'pair_invalid_provider'
		WHEN has_legacy_provider AND has_legacy_model AND explicit_model_valid
			THEN 'pair_valid'
		ELSE 'pair_invalid_model_provider_default'
	END
FROM evaluated
ON CONFLICT ("bot_id", "chat_id") DO UPDATE SET
	"legacy_provider_id" = excluded."legacy_provider_id",
	"legacy_model_id" = excluded."legacy_model_id",
	"effective_provider_id" = excluded."effective_provider_id",
	"selected_provider_id" = excluded."selected_provider_id",
	"selected_model_id" = excluded."selected_model_id",
	"outcome" = excluded."outcome",
	"reason" = excluded."reason",
	"migrated_at" = now();--> statement-breakpoint

INSERT INTO "chat_ai_selections" (
	"bot_id", "chat_id", "provider_id", "model_id", "revision",
	"updated_by_kind", "updated_by_id", "created_at", "updated_at"
)
SELECT
	"bot_id", "chat_id", "selected_provider_id", "selected_model_id", 1,
	NULL, NULL, "migrated_at", "migrated_at"
FROM "chat_ai_selection_migration_reports"
WHERE "selected_provider_id" IS NOT NULL
	AND "chat_id" > 0
	AND "chat_id" <= 9007199254740991
ON CONFLICT ("bot_id", "chat_id") DO NOTHING;
