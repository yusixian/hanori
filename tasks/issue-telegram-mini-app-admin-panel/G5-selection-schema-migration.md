# G5 chat AI selection schema migration

## Forward contract

`chat_ai_selections` is the new source of truth for per-chat Provider/model selection:

- `(bot_id, chat_id)` is unique and Bot-scoped;
- no row means inherit the Bot-wide active Provider and model;
- `provider_id` is required and `model_id = null` means use that Provider's default model;
- `revision` starts at `1` and every update must increase it;
- `(updated_by_kind, updated_by_id)` is either entirely null for system migration/reconciliation or identifies `telegram_user` / `better_auth_user`; Telegram actors use a positive safe-integer decimal string, while Better Auth IDs remain opaque strings.

The legacy `chat_provider_overrides` and `chat_model_overrides` tables are retained unchanged for rollback inspection. New G5 runtime code must read and write only `chat_ai_selections`.

## Deterministic legacy backfill

The migration evaluates the union of legacy Provider and model rows once against each Bot's stored Provider catalog. The effective Provider is `activeProviderId` when it exists, otherwise the first configured Provider. A legacy flat AI config is evaluated as the same synthetic `__legacy__` Provider used by application normalization. A model belongs to a Provider only when it is that Provider's default model or appears in that Provider's configured/discovered `models` list.

| Legacy state                                       | Safe result                           |
| -------------------------------------------------- | ------------------------------------- |
| valid Provider only                                | Save Provider with `model_id = null`. |
| invalid Provider only                              | Save no row; inherit.                 |
| model only, valid for effective Provider           | Save effective Provider and model.    |
| model only, no effective Provider or invalid model | Save no row; inherit.                 |
| valid Provider + valid model pair                  | Save the pair.                        |
| valid Provider + model outside that Provider       | Save Provider with `model_id = null`. |
| invalid Provider + any model                       | Save no row; inherit.                 |

Every legacy chat receives one durable row in `chat_ai_selection_migration_reports`, including legacy IDs, migration-time effective Provider, selected IDs, outcome, reason, and timestamp. The report contains no AI config JSON, credentials, URLs, prompts, or chat content.

## Inspection and rollback

Before enabling the G5 runtime, inspect outcome counts and every inherited row:

```sql
select outcome, reason, count(*)
from chat_ai_selection_migration_reports
group by outcome, reason
order by outcome, reason;

select *
from chat_ai_selection_migration_reports
where outcome = 'inherited'
order by bot_id, chat_id;
```

Rollback disables the G5 runtime and returns the application to the preserved legacy tables. Do not copy new-table values back automatically: subsequent G5 writes may have no lossless representation across the two old tables. Keep both new tables and the report until a backed-up production rehearsal has been accepted.
