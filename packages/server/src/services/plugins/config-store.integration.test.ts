import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { createDb } from "@cos-tool-bot/database";
import type { PluginManifest } from "@cos-tool-bot/shared";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { PluginConfigStore } from "./config-store.js";

const baseUrl = process.env.PLUGIN_CONFIG_TEST_DATABASE_URL;
const manifest: PluginManifest = {
  apiVersion: 1,
  id: "fixture.plugin",
  name: "Fixture plugin",
  version: "1.0.0",
  description: "Synthetic configuration fixture",
  author: "Test",
  config: [
    { key: "cookie", label: "Cookie", type: "text", secret: true, required: true },
    { key: "limit", label: "Limit", type: "integer", default: 5, min: 1, max: 20 },
  ],
};
const encryptionKey = "synthetic-plugin-config-test-key";

// Explicit opt-in, dedicated local database. Never reuse the application's DATABASE_URL.
describe.skipIf(!baseUrl)("plugin configuration PostgreSQL persistence", () => {
  const databaseName = `plugin_config_${randomUUID().replaceAll("-", "")}_test`;
  let admin: ReturnType<typeof createDb> | undefined;
  let connection: ReturnType<typeof createDb>;
  let url: string;
  let store: PluginConfigStore;
  let botId: string;
  let otherBotId: string;
  let created = false;

  beforeAll(async () => {
    const parsed = new URL(baseUrl!);
    if (!["127.0.0.1", "localhost"].includes(parsed.hostname) || !parsed.pathname.endsWith("_test"))
      throw new Error("Plugin config tests require an explicit local *_test database");
    admin = createDb(parsed.href);
    await admin.client.unsafe(`CREATE DATABASE "${databaseName}"`);
    created = true;
    parsed.pathname = `/${databaseName}`;
    url = parsed.href;
    connection = createDb(url);
    store = new PluginConfigStore(connection.db, encryptionKey);
    await connection.client.unsafe("CREATE TABLE public.bots (id uuid PRIMARY KEY)");
    // Execute the generated migration unchanged, including its public.bots foreign key.
    const migration = await readFile(
      new URL("../../../../database/drizzle/0058_sloppy_jocasta.sql", import.meta.url),
      "utf8",
    );
    for (const statement of migration.split("--> statement-breakpoint"))
      await connection.client.unsafe(statement);
  });

  afterAll(async () => {
    if (connection) await connection.client.end();
    if (admin) {
      try {
        if (created) await admin.client.unsafe(`DROP DATABASE "${databaseName}"`);
      } finally {
        await admin.client.end();
      }
    }
  });

  beforeEach(async () => {
    await connection.client.unsafe("TRUNCATE public.bots CASCADE");
    botId = randomUUID();
    otherBotId = randomUUID();
    await connection.client`INSERT INTO public.bots (id) VALUES (${botId}), (${otherBotId})`;
  });

  async function seed(enabled = true) {
    const initial = await store.get(botId, manifest);
    return store.save(botId, manifest, {
      expectedRevision: initial.revision,
      manifestHash: initial.manifestHash,
      configuration: { values: { limit: 7 }, secrets: { cookie: "synthetic-cookie" } },
      enabled,
    });
  }

  async function conflictingSaves(start: () => Promise<unknown>[]) {
    const blocker = createDb(url);
    let writes: Promise<PromiseSettledResult<unknown>[]> | undefined;
    await connection.client.unsafe(`
      CREATE FUNCTION hold_plugin_config_write() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        PERFORM pg_advisory_xact_lock(134763781);
        RETURN NEW;
      END $$;
      CREATE TRIGGER hold_plugin_config_write BEFORE INSERT OR UPDATE ON bot_plugin_configs
      FOR EACH ROW EXECUTE FUNCTION hold_plugin_config_write();
    `);
    try {
      await blocker.client.begin(async (transaction) => {
        await transaction.unsafe("SELECT pg_advisory_xact_lock(134763781)");
        writes = Promise.allSettled(start());
        const deadline = Date.now() + 3000;
        // Release only after both real writes are blocked. Both reads therefore saw the old row.
        while (Date.now() < deadline) {
          const [waiting] = await connection.client`
            SELECT count(*)::integer AS count FROM pg_stat_activity
            WHERE datname=current_database() AND wait_event_type='Lock'
              AND query LIKE '%bot_plugin_configs%'
          `;
          if (waiting!.count === 2) return;
          await delay(10);
        }
        throw new Error("Both plugin configuration writes must reach the database conflict");
      });
      return await writes!;
    } finally {
      if (writes) await writes;
      await blocker.client.end();
      await connection.client.unsafe(`
        DROP TRIGGER hold_plugin_config_write ON bot_plugin_configs;
        DROP FUNCTION hold_plugin_config_write();
      `);
    }
  }

  it("uses defaults for an existing Bot and rejects a missing Bot", async () => {
    expect(await store.get(botId, manifest)).toMatchObject({
      revision: 0,
      enabled: false,
      needsReview: false,
      configuredVersion: null,
      configuration: { values: { limit: 5 }, configuredSecrets: [] },
    });
    await expect(store.runtime(botId, manifest)).resolves.toBeNull();
    await expect(store.get(randomUUID(), manifest)).rejects.toMatchObject({ code: "not_found" });
  });

  it("persists ciphertext and write-only state across a new database connection", async () => {
    const saved = await seed();
    expect(saved).toMatchObject({
      revision: 1,
      enabled: true,
      configuredVersion: "1.0.0",
      needsReview: false,
      configuration: { values: { limit: 7 }, configuredSecrets: ["cookie"] },
    });
    const [row] = await connection.client`SELECT * FROM bot_plugin_configs WHERE bot_id=${botId}`;
    expect(JSON.stringify(row)).not.toContain("synthetic-cookie");
    expect(row!.values).not.toHaveProperty("cookie");
    expect(typeof row!.encrypted_secrets.cookie).toBe("string");
    const restarted = createDb(url);
    try {
      const reloaded = new PluginConfigStore(restarted.db, encryptionKey);
      await expect(reloaded.get(botId, manifest)).resolves.toEqual(saved);
      await expect(reloaded.runtime(botId, manifest)).resolves.toEqual({
        revision: 1,
        configuration: { limit: 7, cookie: "synthetic-cookie" },
      });
    } finally {
      await restarted.client.end();
    }
  });

  it("isolates Bots and plugin ids, including a replayed ciphertext", async () => {
    await seed();
    const otherManifest = { ...manifest, id: "fixture.other" };
    expect((await store.get(otherBotId, manifest)).configuration.configuredSecrets).toEqual([]);
    expect((await store.get(botId, otherManifest)).configuration.configuredSecrets).toEqual([]);
    await connection.client`
      INSERT INTO bot_plugin_configs (bot_id, plugin_id, manifest_version, manifest_hash, values, encrypted_secrets, enabled)
      SELECT ${otherBotId}, plugin_id, manifest_version, manifest_hash, values, encrypted_secrets, enabled
      FROM bot_plugin_configs WHERE bot_id=${botId}
    `;
    await expect(store.runtime(otherBotId, manifest)).rejects.toMatchObject({
      name: "PluginSecretError",
    });
    expect(JSON.stringify(await store.get(otherBotId, manifest))).not.toContain("synthetic-cookie");
  });

  it("allows exactly one simultaneous first save", async () => {
    const initial = await store.get(botId, manifest);
    const results = await conflictingSaves(() =>
      [7, 9].map((limit) =>
        store.save(botId, manifest, {
          expectedRevision: 0,
          manifestHash: initial.manifestHash,
          configuration: { values: { limit } },
        }),
      ),
    );
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.find((result) => result.status === "rejected")).toMatchObject({
      reason: { code: "stale_revision" },
    });
    const state = await store.get(botId, manifest);
    expect(state.revision).toBe(1);
    expect([7, 9]).toContain(state.configuration.values.limit);
  });

  it("rejects a stale update without merging over the winning secret/value changes", async () => {
    const first = await seed();
    const results = await conflictingSaves(() =>
      [8, 12].map((limit) =>
        store.save(botId, manifest, {
          expectedRevision: first.revision,
          manifestHash: first.manifestHash,
          configuration: { values: { limit }, secrets: { cookie: `synthetic-${limit}` } },
        }),
      ),
    );
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.find((result) => result.status === "rejected")).toMatchObject({
      reason: { code: "stale_revision" },
    });
    const current = await store.runtime(botId, manifest);
    expect(current!.revision).toBe(2);
    expect(current!.configuration.cookie).toBe(`synthetic-${current!.configuration.limit}`);
  });

  it("saves an incomplete draft but cannot enable it until all required values are present", async () => {
    const initial = await store.get(botId, manifest);
    const draft = await store.save(botId, manifest, {
      expectedRevision: 0,
      manifestHash: initial.manifestHash,
      configuration: { values: {} },
    });
    await expect(
      store.save(botId, manifest, {
        expectedRevision: draft.revision,
        manifestHash: draft.manifestHash,
        enabled: true,
      }),
    ).rejects.toMatchObject({ name: "PluginConfigError" });
    expect((await store.get(botId, manifest)).revision).toBe(1);
    const saved = await store.save(botId, manifest, {
      expectedRevision: draft.revision,
      manifestHash: draft.manifestHash,
      enabled: true,
      configuration: { values: {}, secrets: { cookie: "new-synthetic-cookie" } },
    });
    expect(saved.enabled).toBe(true);
  });

  it("preserves blank secrets, supports explicit clearing and blocks clearing required values while enabled", async () => {
    const first = await seed();
    const second = await store.save(botId, manifest, {
      expectedRevision: first.revision,
      manifestHash: first.manifestHash,
      configuration: { values: { limit: null }, secrets: { cookie: "" } },
    });
    expect((await store.runtime(botId, manifest))!.configuration).toEqual({
      limit: 5,
      cookie: "synthetic-cookie",
    });
    await expect(
      store.save(botId, manifest, {
        expectedRevision: second.revision,
        manifestHash: second.manifestHash,
        configuration: { values: {}, secrets: { cookie: null } },
      }),
    ).rejects.toMatchObject({ name: "PluginConfigError" });
    const cleared = await store.save(botId, manifest, {
      expectedRevision: second.revision,
      manifestHash: second.manifestHash,
      enabled: false,
      configuration: { values: {}, secrets: { cookie: null } },
    });
    expect(cleared.configuration.configuredSecrets).toEqual([]);
    await expect(store.runtime(botId, manifest)).resolves.toBeNull();
  });

  it("requires review of a changed manifest and never publishes a downgraded secret", async () => {
    const first = await seed();
    const upgraded: PluginManifest = {
      ...manifest,
      version: "2.0.0",
      config: [{ key: "cookie", label: "Public note", type: "text" }, manifest.config[1]!],
    };
    const review = await store.get(botId, upgraded);
    expect(review.needsReview).toBe(true);
    expect(review.configuredVersion).toBe("1.0.0");
    expect(review.configuration.values).not.toHaveProperty("cookie");
    await expect(store.runtime(botId, upgraded)).rejects.toMatchObject({
      code: "manifest_changed",
    });
    await expect(
      store.save(botId, upgraded, {
        expectedRevision: first.revision,
        manifestHash: first.manifestHash,
        configuration: { values: {} },
      }),
    ).rejects.toMatchObject({ code: "manifest_changed" });
    await expect(
      store.save(botId, upgraded, {
        expectedRevision: review.revision,
        manifestHash: review.manifestHash,
        enabled: true,
      }),
    ).rejects.toMatchObject({ code: "manifest_changed" });
    const accepted = await store.save(botId, upgraded, {
      expectedRevision: review.revision,
      manifestHash: review.manifestHash,
      configuration: { values: { cookie: "public synthetic note" } },
    });
    expect(accepted.needsReview).toBe(false);
    expect(accepted.configuration.values.cookie).toBe("public synthetic note");
    const [row] =
      await connection.client`SELECT encrypted_secrets FROM bot_plugin_configs WHERE bot_id=${botId}`;
    expect(row!.encrypted_secrets).toEqual({});
  });

  it("can disable corrupted credentials without decrypting or silently accepting a changed manifest", async () => {
    const first = await seed();
    await connection.client`UPDATE bot_plugin_configs SET encrypted_secrets='{"cookie":"corrupt"}'::json WHERE bot_id=${botId}`;
    const upgraded = { ...manifest, version: "2.0.0" };
    const disabled = await store.save(botId, upgraded, {
      expectedRevision: first.revision,
      manifestHash: first.manifestHash,
      enabled: false,
    });
    expect(disabled).toMatchObject({
      enabled: false,
      revision: 2,
      needsReview: true,
      configuredVersion: "1.0.0",
    });
    await expect(store.runtime(botId, upgraded)).resolves.toBeNull();
    const [row] =
      await connection.client`SELECT encrypted_secrets, manifest_hash FROM bot_plugin_configs WHERE bot_id=${botId}`;
    expect(row!.encrypted_secrets).toEqual({ cookie: "corrupt" });
    expect(row!.manifest_hash).toBe(first.manifestHash);
    const repaired = await store.save(botId, upgraded, {
      expectedRevision: disabled.revision,
      manifestHash: disabled.manifestHash,
      enabled: true,
      configuration: { values: {}, secrets: { cookie: "repaired-synthetic-cookie" } },
    });
    expect(repaired.needsReview).toBe(false);
    expect((await store.runtime(botId, upgraded))!.configuration.cookie).toBe(
      "repaired-synthetic-cookie",
    );
  });

  it("cascades configuration deletion with its Bot and enforces revision/hash constraints", async () => {
    await seed();
    await expect(
      connection.client`UPDATE bot_plugin_configs SET revision=0 WHERE bot_id=${botId}`,
    ).rejects.toMatchObject({ code: "23514" });
    await expect(
      connection.client`UPDATE bot_plugin_configs SET manifest_hash='invalid' WHERE bot_id=${botId}`,
    ).rejects.toMatchObject({ code: "23514" });
    await connection.client`DELETE FROM bots WHERE id=${botId}`;
    expect(
      await connection.client`SELECT * FROM bot_plugin_configs WHERE bot_id=${botId}`,
    ).toHaveLength(0);
    await expect(store.runtime(botId, manifest)).rejects.toMatchObject({ code: "not_found" });
  });
});
