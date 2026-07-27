import { readFileSync } from "node:fs";
import { resolveLegacyChatAiSelection } from "@cos-tool-bot/database";
import { describe, expect, it } from "vitest";

const migrationSql = readFileSync(
  new URL("../../../database/drizzle/0038_perpetual_metal_master.sql", import.meta.url),
  "utf8",
);
const privateChatCompatibilityMigrationSql = readFileSync(
  new URL("../../../database/drizzle/0040_confused_korath.sql", import.meta.url),
  "utf8",
);

const providers = [
  {
    id: "openai",
    defaultModel: "gpt-default",
    models: [{ id: "gpt-default" }, { id: "gpt-fast" }],
  },
  {
    id: "gemini",
    defaultModel: "gemini-default",
    models: [{ id: "gemini-default" }, { id: "gemini-pro" }],
  },
];

describe("resolveLegacyChatAiSelection", () => {
  it("keeps a valid provider-only row with its default model implicit", () => {
    expect(
      resolveLegacyChatAiSelection({
        legacyProviderId: "gemini",
        legacyModelId: null,
        effectiveProviderId: "openai",
        providers,
      }),
    ).toEqual({
      providerId: "gemini",
      modelId: null,
      outcome: "migrated_provider_default",
      reason: "provider_only_valid",
    });
  });

  it("binds model-only rows only to the effective provider that owns the model", () => {
    expect(
      resolveLegacyChatAiSelection({
        legacyProviderId: null,
        legacyModelId: "gpt-fast",
        effectiveProviderId: "openai",
        providers,
      }),
    ).toMatchObject({ providerId: "openai", modelId: "gpt-fast", reason: "model_only_valid" });
    expect(
      resolveLegacyChatAiSelection({
        legacyProviderId: null,
        legacyModelId: "gemini-pro",
        effectiveProviderId: "openai",
        providers,
      }),
    ).toEqual({
      providerId: null,
      modelId: null,
      outcome: "inherited",
      reason: "model_only_invalid_model",
    });
  });

  it("keeps valid pairs, falls invalid models back to the provider default, and rejects invalid providers", () => {
    expect(
      resolveLegacyChatAiSelection({
        legacyProviderId: "gemini",
        legacyModelId: "gemini-pro",
        effectiveProviderId: "openai",
        providers,
      }),
    ).toMatchObject({ providerId: "gemini", modelId: "gemini-pro", reason: "pair_valid" });
    expect(
      resolveLegacyChatAiSelection({
        legacyProviderId: "gemini",
        legacyModelId: "gpt-fast",
        effectiveProviderId: "openai",
        providers,
      }),
    ).toEqual({
      providerId: "gemini",
      modelId: null,
      outcome: "migrated_provider_default",
      reason: "pair_invalid_model_provider_default",
    });
    expect(
      resolveLegacyChatAiSelection({
        legacyProviderId: "missing",
        legacyModelId: "gpt-fast",
        effectiveProviderId: "openai",
        providers,
      }),
    ).toEqual({
      providerId: null,
      modelId: null,
      outcome: "inherited",
      reason: "pair_invalid_provider",
    });
  });

  it("inherits when a model-only row has no effective provider", () => {
    expect(
      resolveLegacyChatAiSelection({
        legacyProviderId: null,
        legacyModelId: "orphan",
        effectiveProviderId: null,
        providers: [],
      }),
    ).toEqual({
      providerId: null,
      modelId: null,
      outcome: "inherited",
      reason: "model_only_no_effective_provider",
    });
  });
});

describe("0038 chat AI selection migration", () => {
  it("persists every legacy chat report before inserting safe selections", () => {
    const reportInsert = migrationSql.indexOf('INSERT INTO "chat_ai_selection_migration_reports"');
    const selectionInsert = migrationSql.indexOf('INSERT INTO "chat_ai_selections"');

    expect(reportInsert).toBeGreaterThan(-1);
    expect(selectionInsert).toBeGreaterThan(reportInsert);
    expect(migrationSql).not.toContain('DROP TABLE "chat_provider_overrides"');
    expect(migrationSql).not.toContain('DROP TABLE "chat_model_overrides"');
  });

  it("requires model ownership before accepting a model-only legacy row", () => {
    expect(migrationSql).toMatch(
      /WHEN NOT has_legacy_provider AND has_legacy_model AND effective_model_valid\s+THEN 'model_only_valid'\s+WHEN NOT has_legacy_provider AND has_legacy_model\s+THEN 'model_only_invalid_model'/,
    );
    expect(migrationSql).not.toMatch(
      /WHEN NOT has_legacy_provider AND has_legacy_model AND effective_provider_valid\s+THEN 'model_only_valid'/,
    );
  });

  it("reports legacy private or unsafe IDs without creating group selections", () => {
    expect(migrationSql).not.toContain('CONSTRAINT "chat_ai_selection_reports_chat_id_check"');
    expect(migrationSql).toContain("THEN 'ignored'");
    expect(migrationSql).toContain("THEN 'non_group_chat'");
    expect(migrationSql).toContain("THEN 'unsafe_chat_id'");
    expect(migrationSql).toMatch(
      /WHERE "selected_provider_id" IS NOT NULL\s+AND "chat_id" < 0\s+AND "chat_id" >= -9007199254740991/,
    );
  });
});

describe("0040 private chat AI selection compatibility migration", () => {
  it("widens durable selections to safe non-zero Telegram conversation IDs", () => {
    expect(privateChatCompatibilityMigrationSql).toContain(
      '"chat_id" <> 0 and "chat_ai_selections"."chat_id" between -9007199254740991 and 9007199254740991',
    );
  });

  it("re-evaluates positive legacy rows before restoring only validated selections", () => {
    expect(privateChatCompatibilityMigrationSql).toMatch(
      /coalesce\(provider\.chat_id, model\.chat_id\) > 0/,
    );
    expect(privateChatCompatibilityMigrationSql).toContain(
      'INSERT INTO "chat_ai_selection_migration_reports"',
    );
    expect(privateChatCompatibilityMigrationSql).toContain('INSERT INTO "chat_ai_selections"');
    expect(privateChatCompatibilityMigrationSql).toMatch(
      /WHERE "selected_provider_id" IS NOT NULL\s+AND "chat_id" > 0\s+AND "chat_id" <= 9007199254740991/,
    );
    expect(privateChatCompatibilityMigrationSql).toContain(
      'ON CONFLICT ("bot_id", "chat_id") DO NOTHING',
    );
  });
});
