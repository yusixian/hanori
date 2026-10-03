import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setImmediate as nextTurn, setTimeout as delay } from "node:timers/promises";
import { createDb } from "@cos-tool-bot/database";
import { parsePluginManifest } from "@cos-tool-bot/shared";
import type {
  PluginActor,
  PluginDefinition,
  PluginManifest,
  PluginLoginResult,
  PluginSession,
} from "@cos-tool-bot/shared";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type Mock,
} from "vitest";
import { GitPluginArtifacts } from "./git-artifacts.js";
import { PluginManager } from "./manager.js";

const baseUrl = process.env.PLUGIN_CONFIG_TEST_DATABASE_URL;
const encryptionKey = "synthetic-manager-integration-key";
const repository = "https://github.com/fixture/plugin";
const firstCommit = "a".repeat(40);
const secondCommit = "b".repeat(40);
const manifest: PluginManifest = {
  apiVersion: 1,
  id: "fixture.plugin",
  name: "Fixture plugin",
  version: "1.0.0",
  description: "Synthetic manager integration fixture",
  author: "Test",
  login: { type: "qr" },
  config: [
    { key: "cookie", label: "Cookie", type: "text", secret: true, required: true },
    { key: "limit", label: "Limit", type: "integer", min: 1, max: 20, default: 5 },
  ],
};
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((finish) => {
    resolve = finish;
  });
  return { promise, resolve };
}

// Explicit local test database opt-in; every suite creates and drops its own database.
describe.skipIf(!baseUrl)("PluginManager PostgreSQL lifecycle", () => {
  const databaseName = `plugin_manager_${randomUUID().replaceAll("-", "")}_test`;
  let admin: ReturnType<typeof createDb> | undefined;
  let connection: ReturnType<typeof createDb>;
  let url: string;
  let created = false;
  let directory: string;
  let manager: PluginManager;
  let artifacts: GitPluginArtifacts;
  let definition: PluginDefinition;
  let botId: string;
  let otherBotId: string;
  let execute: Mock<() => Promise<{ success: boolean }>>;
  let dispose: Mock<() => Promise<void>>;
  let callStarted: ReturnType<typeof deferred<AbortSignal>>;

  beforeAll(async () => {
    const parsed = new URL(baseUrl!);
    if (!["127.0.0.1", "localhost"].includes(parsed.hostname) || !parsed.pathname.endsWith("_test"))
      throw new Error("Plugin manager tests require an explicit local *_test database");
    admin = createDb(parsed.href);
    await admin.client.unsafe(`CREATE DATABASE "${databaseName}"`);
    created = true;
    parsed.pathname = `/${databaseName}`;
    url = parsed.href;
    connection = createDb(url);
    await connection.client.unsafe("CREATE TABLE public.bots (id uuid PRIMARY KEY)");
    for (const filename of [
      "0058_sloppy_jocasta.sql",
      "0059_superb_lifeguard.sql",
      "0060_gigantic_cargill.sql",
    ]) {
      const migration = await readFile(
        new URL(`../../../../database/drizzle/${filename}`, import.meta.url),
        "utf8",
      );
      for (const statement of migration.split("--> statement-breakpoint"))
        await connection.client.unsafe(statement);
    }
  }, 15_000);

  beforeEach(async () => {
    await connection.client.unsafe("TRUNCATE public.bots, plugin_installations CASCADE");
    botId = randomUUID();
    otherBotId = randomUUID();
    await connection.client`INSERT INTO public.bots (id) VALUES (${botId}), (${otherBotId})`;
    directory = await mkdtemp(join(tmpdir(), "plugin-manager-fixture-"));
    artifacts = new GitPluginArtifacts(directory);
    callStarted = deferred<AbortSignal>();
    execute = vi.fn(async () => ({ success: true }));
    dispose = vi.fn(async () => {});
    definition = {
      apiVersion: 1,
      createSession: async (context) => ({
        tools: [
          {
            name: "read",
            description: "Read synthetic configuration",
            inputSchema: { type: "object" },
            effect: "read_only",
            access: "all",
            execute: async () => {
              await execute();
              return {
                limit: context.configuration.limit,
                authenticated: context.configuration.cookie === "synthetic-cookie",
              };
            },
          },
          {
            name: "wait",
            description: "Wait for cancellation",
            inputSchema: { type: "object" },
            effect: "read_only",
            access: "all",
            execute: async (_input, signal) => {
              callStarted.resolve(signal);
              return new Promise((resolve) =>
                signal.addEventListener("abort", () => resolve({ cancelled: true }), {
                  once: true,
                }),
              );
            },
          },
        ],
        dispose,
      }),
    };
    manager = new PluginManager(connection.db, encryptionKey, artifacts, [
      { manifest, definition },
    ]);
  });

  afterEach(async () => {
    await manager?.close();
    if (directory) await rm(directory, { recursive: true, force: true });
    vi.restoreAllMocks();
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

  function actor(id = botId): PluginActor {
    return { botId: id, chatId: 10, userId: 20, isAdmin: true, isPrivate: true, readOnly: true };
  }
  async function installBuiltin() {
    return manager.install({ builtinId: manifest.id, trustHostAccess: true });
  }
  async function enable(id = botId) {
    const initial = await manager.getBot(manifest.id, id);
    return manager.saveBot(manifest.id, id, {
      expectedRevision: initial.revision,
      manifestHash: initial.manifestHash,
      configuration: { values: { limit: 7 }, secrets: { cookie: "synthetic-cookie" } },
      enabled: true,
    });
  }
  async function readValue(runtime = manager, id = botId) {
    const session = await runtime.createSession(actor(id));
    try {
      return await session.tools
        .find((tool) => tool.name.endsWith("_read"))!
        .execute({}, new AbortController().signal);
    } finally {
      await session.dispose();
    }
  }

  async function startLogin(
    poll = vi.fn(
      async (): Promise<PluginLoginResult> => ({
        status: "authorized",
        secrets: { cookie: "synthetic-qr-cookie" },
        account: { name: "QR account" },
      }),
    ),
  ) {
    const cleanup = vi.fn();
    definition.startLogin = vi.fn(async () => ({
      qrUrl: "https://example.com/login?code=synthetic",
      poll,
      dispose: cleanup,
    }));
    const current = await manager.getBot(manifest.id, botId);
    const login = await manager.logins.start("web-session", manifest.id, botId, {
      expectedRevision: current.revision,
      manifestHash: current.manifestHash,
    });
    return { login, poll, cleanup };
  }

  async function finishLogin(id: string) {
    let state = await manager.logins.poll("web-session", manifest.id, botId, id);
    await vi.waitFor(
      async () => {
        if (state.status === "saving")
          state = await manager.logins.poll("web-session", manifest.id, botId, id);
        expect(state.status).not.toBe("saving");
      },
      { timeout: 4000, interval: 10 },
    );
    return state;
  }
  async function gitFixtures(upgraded: PluginManifest) {
    const fixtures = new Map<string, { manifest: PluginManifest; directory: string }>();
    for (const [commit, metadata] of [
      [firstCommit, manifest],
      [secondCommit, upgraded],
    ] as const) {
      const artifactDirectory = join(directory, commit);
      await mkdir(artifactDirectory);
      await writeFile(
        join(artifactDirectory, "index.mjs"),
        `export default {
        apiVersion: 1,
        async createSession(context) {
          return { tools: [{ name: "read", description: "Read pinned version", inputSchema: {type:"object"}, effect:"read_only", access:"all",
            async execute() { return { version: ${JSON.stringify(metadata.version)}, limit: context.configuration.limit, authenticated: context.configuration.cookie === "synthetic-cookie" }; }
          }] };
        }
      };`,
      );
      fixtures.set(commit, {
        manifest: parsePluginManifest(metadata),
        directory: artifactDirectory,
      });
    }
    const stage = vi.spyOn(artifacts, "stage").mockImplementation(async (source) => {
      const artifact = fixtures.get(source.commit);
      if (!artifact) throw new Error("Unknown synthetic commit");
      return { ...artifact, repository: source.repository, commit: source.commit };
    });
    vi.spyOn(artifacts, "locate").mockImplementation(async (_id, commit) => {
      const artifact = fixtures.get(commit);
      if (!artifact) throw new Error("Unknown synthetic commit");
      return artifact;
    });
    return stage;
  }

  it("lists builtin availability, persists installation across a fresh connection, and rejects duplicate install", async () => {
    expect(await manager.list()).toMatchObject([
      { manifest: { id: manifest.id }, installed: false, revision: 0 },
    ]);
    const installed = await installBuiltin();
    expect(installed).toMatchObject({
      installed: true,
      source: "builtin",
      revision: 1,
      commit: null,
    });
    await expect(installBuiltin()).rejects.toMatchObject({ code: "already_installed" });
    const restartedConnection = createDb(url);
    const restarted = new PluginManager(restartedConnection.db, encryptionKey, artifacts, [
      { manifest, definition },
    ]);
    try {
      expect(await restarted.list()).toEqual([installed]);
    } finally {
      await restarted.close();
      await restartedConnection.client.end();
    }
  });

  it("keeps per-Bot secrets encrypted and write-only while supplying enabled runtime tools", async () => {
    await installBuiltin();
    const saved = await enable();
    expect(saved).toMatchObject({
      enabled: true,
      runtime: { status: "ready" },
      configuration: { values: { limit: 7 }, configuredSecrets: ["cookie"] },
    });
    expect(JSON.stringify(saved)).not.toContain("synthetic-cookie");
    const [stored] =
      await connection.client`SELECT * FROM bot_plugin_configs WHERE bot_id=${botId}`;
    expect(JSON.stringify(stored)).not.toContain("synthetic-cookie");
    expect(stored!.values).not.toHaveProperty("cookie");
    expect(stored!.encrypted_secrets.cookie).toEqual(expect.any(String));
    expect(await manager.getBot(manifest.id, otherBotId)).toMatchObject({
      enabled: false,
      revision: 0,
      configuration: { configuredSecrets: [] },
    });
    const otherSession = await manager.createSession(actor(otherBotId));
    expect(otherSession.tools).toHaveLength(0);
    await otherSession.dispose();
    expect(await readValue()).toEqual({ limit: 7, authenticated: true });
    expect(execute).toHaveBeenCalledOnce();
    expect(dispose).toHaveBeenCalledOnce();
  });

  it("saves verified QR credentials encrypted for a disabled Bot without enabling it", async () => {
    await installBuiltin();
    const { login, cleanup } = await startLogin();
    expect(login.status).toBe("waiting");
    const connected = await finishLogin(login.id);
    expect(connected).toMatchObject({
      status: "connected",
      account: { name: "QR account" },
      botState: {
        enabled: false,
        revision: 1,
        configuration: { values: { limit: 5 }, configuredSecrets: ["cookie"] },
      },
    });
    expect(JSON.stringify(connected)).not.toContain("synthetic-qr-cookie");
    const [stored] =
      await connection.client`SELECT * FROM bot_plugin_configs WHERE bot_id=${botId}`;
    expect(JSON.stringify(stored)).not.toContain("synthetic-qr-cookie");
    expect(stored!.encrypted_secrets.cookie).toEqual(expect.any(String));
    expect(cleanup).toHaveBeenCalledOnce();
    expect((await manager.getBot(manifest.id, otherBotId)).configuration.configuredSecrets).toEqual(
      [],
    );
  });

  it("replaces only login secrets, preserves ordinary settings and stops the previous tool session", async () => {
    await installBuiltin();
    const saved = await enable();
    const previous = await manager.createSession(actor());
    const { login } = await startLogin();
    expect(await finishLogin(login.id)).toMatchObject({
      status: "connected",
      botState: {
        enabled: true,
        revision: saved.revision + 1,
        configuration: { values: { limit: 7 }, configuredSecrets: ["cookie"] },
      },
    });
    expect(await manager.runtimeConfiguration(manifest.id, botId)).toMatchObject({
      configuration: { cookie: "synthetic-qr-cookie", limit: 7 },
    });
    await expect(previous.tools[0]!.execute({}, new AbortController().signal)).rejects.toThrow();
    await previous.dispose();
  });

  it("does not overwrite a configuration changed through another manager", async () => {
    await installBuiltin();
    const saved = await enable();
    const { login, poll } = await startLogin();
    const other = new PluginManager(connection.db, encryptionKey, artifacts, [
      { manifest, definition },
    ]);
    try {
      await other.saveBot(manifest.id, botId, {
        expectedRevision: saved.revision,
        manifestHash: saved.manifestHash,
        configuration: { values: { limit: 9 } },
      });
      expect(await manager.logins.poll("web-session", manifest.id, botId, login.id)).toMatchObject({
        status: "conflict",
      });
      expect(poll).not.toHaveBeenCalled();
      expect(await manager.runtimeConfiguration(manifest.id, botId)).toMatchObject({
        configuration: { cookie: "synthetic-cookie", limit: 9 },
      });
    } finally {
      await other.close();
    }
  });

  it("discards authorization arriving after cancellation and keeps existing credentials", async () => {
    await installBuiltin();
    const saved = await enable();
    const result = deferred<PluginLoginResult>();
    const began = deferred<void>();
    const { login } = await startLogin(
      vi.fn(async () => {
        began.resolve();
        return result.promise;
      }),
    );
    const polling = manager.logins.poll("web-session", manifest.id, botId, login.id);
    await began.promise;
    await manager.logins.cancel("web-session", manifest.id, botId, login.id);
    result.resolve({
      status: "authorized",
      secrets: { cookie: "late-cookie" },
      account: { name: "Late" },
    });
    expect(await polling).toMatchObject({ status: "cancelled" });
    expect((await manager.getBot(manifest.id, botId)).revision).toBe(saved.revision);
    expect(await readValue()).toEqual({ limit: 7, authenticated: true });
  });

  it("rejects undeclared or ordinary fields returned as login secrets", async () => {
    await installBuiltin();
    const saved = await enable();
    const { login } = await startLogin(
      vi.fn(async () => ({
        status: "authorized",
        secrets: { limit: "untrusted" },
        account: { name: "QR account" },
      })),
    );
    expect(await finishLogin(login.id)).toMatchObject({
      status: "save_unknown",
    });
    expect((await manager.getBot(manifest.id, botId)).revision).toBe(saved.revision);
    expect(await readValue()).toEqual({ limit: 7, authenticated: true });
  });

  it("does not authorize a changed manifest merely by logging in", async () => {
    await installBuiltin();
    await enable();
    const updated = new PluginManager(connection.db, encryptionKey, artifacts, [
      {
        manifest: { ...manifest, version: "1.1.0" },
        definition,
      },
    ]);
    try {
      const current = await updated.getBot(manifest.id, botId);
      expect(current.needsReview).toBe(true);
      definition.startLogin = vi.fn();
      expect(
        await updated.logins.start("web-session", manifest.id, botId, {
          expectedRevision: current.revision,
          manifestHash: current.manifestHash,
        }),
      ).toMatchObject({ status: "conflict" });
      expect(definition.startLogin).not.toHaveBeenCalled();
      expect((await updated.getBot(manifest.id, botId)).needsReview).toBe(true);
    } finally {
      await updated.close();
    }
  });

  it("does not report cancellation while PostgreSQL is committing verified credentials", async () => {
    await installBuiltin();
    await enable();
    const { login } = await startLogin();
    const blocker = createDb(url);
    let pending: ReturnType<typeof manager.logins.poll> | undefined;
    await connection.client.unsafe(`
      CREATE FUNCTION hold_qr_commit() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        PERFORM pg_advisory_xact_lock(134763782);
        RETURN NEW;
      END $$;
      CREATE CONSTRAINT TRIGGER hold_qr_commit AFTER INSERT OR UPDATE ON bot_plugin_configs
      DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION hold_qr_commit();
    `);
    try {
      await blocker.client.begin(async (transaction) => {
        await transaction.unsafe("SELECT pg_advisory_xact_lock(134763782)");
        pending = manager.logins.poll("web-session", manifest.id, botId, login.id);
        let blocked = false;
        const deadline = Date.now() + 3000;
        while (Date.now() < deadline) {
          const [waiting] = await connection.client`
            SELECT count(*)::integer AS count FROM pg_stat_activity
            WHERE datname=current_database() AND wait_event_type='Lock' AND lower(query)='commit'
          `;
          if (waiting!.count === 1) {
            blocked = true;
            break;
          }
          await delay(10);
        }
        expect(blocked).toBe(true);
        expect(
          await manager.logins.cancel("web-session", manifest.id, botId, login.id),
        ).toMatchObject({ status: "saving" });
        expect(
          await manager.logins.poll("web-session", manifest.id, botId, login.id),
        ).toMatchObject({ status: "saving" });
      });
      expect(await pending).toMatchObject({ status: "saving" });
      expect(await finishLogin(login.id)).toMatchObject({ status: "connected" });
      expect(await manager.runtimeConfiguration(manifest.id, botId)).toMatchObject({
        configuration: { cookie: "synthetic-qr-cookie" },
      });
    } finally {
      if (pending) await pending;
      await blocker.client.end();
      await connection.client.unsafe(
        "DROP TRIGGER hold_qr_commit ON bot_plugin_configs; DROP FUNCTION hold_qr_commit();",
      );
    }
  });

  it("reports an uncertain result when a lifecycle callback fails after credentials commit", async () => {
    await installBuiltin();
    await enable();
    manager.onConfigurationChanged(async () => {
      throw new Error("synthetic callback failure");
    });
    const { login } = await startLogin();
    expect(await finishLogin(login.id)).toMatchObject({
      status: "save_unknown",
    });
    expect(await manager.runtimeConfiguration(manifest.id, botId)).toMatchObject({
      configuration: { cookie: "synthetic-qr-cookie" },
    });
  });

  it("disabling cancels an in-flight tool and invalidates surviving session references", async () => {
    await installBuiltin();
    const saved = await enable();
    const session = await manager.createSession(actor());
    const outcome = session.tools
      .find((tool) => tool.name.endsWith("_wait"))!
      .execute({}, new AbortController().signal)
      .then(
        (value) => ({ value }),
        (error) => ({ error }),
      );
    const signal = await callStarted.promise;
    await manager.saveBot(manifest.id, botId, {
      expectedRevision: saved.revision,
      manifestHash: saved.manifestHash,
      enabled: false,
    });
    expect(signal.aborted).toBe(true);
    expect(await outcome).toMatchObject({ error: { code: "plugin_stopped" } });
    await expect(
      session.tools
        .find((tool) => tool.name.endsWith("_read"))!
        .execute({}, new AbortController().signal),
    ).rejects.toThrow();
    expect(execute).not.toHaveBeenCalled();
    expect(dispose).toHaveBeenCalledOnce();
    expect((await manager.createSession(actor())).tools).toHaveLength(0);
    await session.dispose();
    expect(dispose).toHaveBeenCalledOnce();
  });

  it("configuration revisions invalidate an old manager's tools even without local cancellation", async () => {
    await installBuiltin();
    const saved = await enable();
    const session = await manager.createSession(actor());
    const other = new PluginManager(connection.db, encryptionKey, artifacts, [
      { manifest, definition },
    ]);
    try {
      const updated = await other.saveBot(manifest.id, botId, {
        expectedRevision: saved.revision,
        manifestHash: saved.manifestHash,
        configuration: { values: { limit: 9 } },
      });
      expect(updated.revision).toBe(saved.revision + 1);
      await expect(
        session.tools
          .find((tool) => tool.name.endsWith("_read"))!
          .execute({}, new AbortController().signal),
      ).rejects.toThrow();
      expect(execute).not.toHaveBeenCalled();
      expect(await readValue(other)).toEqual({ limit: 9, authenticated: true });
    } finally {
      await session.dispose();
      await other.close();
    }
  });

  it("pins imported Git modules, stops old tools on update and requires review before update and rollback runtime", async () => {
    const upgraded = {
      ...manifest,
      version: "2.0.0",
      config: [
        ...manifest.config,
        { key: "region", label: "Region", type: "string" as const, default: "global" },
      ],
    };
    const stage = await gitFixtures(upgraded);
    const installed = await manager.install({
      repository,
      commit: firstCommit,
      trustHostAccess: true,
    });
    await enable();
    expect(await readValue()).toEqual({ version: "1.0.0", limit: 7, authenticated: true });
    const old = await manager.createSession(actor());
    const updated = await manager.update(manifest.id, secondCommit, installed.revision);
    expect(updated).toMatchObject({
      commit: secondCommit,
      previousCommit: firstCommit,
      revision: 2,
      manifest: { version: "2.0.0" },
    });
    expect(stage).toHaveBeenLastCalledWith(
      { repository, commit: secondCommit },
      expect.any(AbortSignal),
    );
    await expect(old.tools[0]!.execute({}, new AbortController().signal)).rejects.toThrow();
    let review = await manager.getBot(manifest.id, botId);
    expect(review).toMatchObject({
      enabled: true,
      needsReview: true,
      runtime: { status: "needs_review" },
    });
    expect((await manager.createSession(actor())).tools).toHaveLength(0);
    await expect(
      manager.saveBot(manifest.id, botId, {
        expectedRevision: review.revision,
        manifestHash: review.manifestHash,
        enabled: true,
      }),
    ).rejects.toMatchObject({ code: "manifest_changed" });
    await manager.saveBot(manifest.id, botId, {
      expectedRevision: review.revision,
      manifestHash: review.manifestHash,
      configuration: { values: {} },
    });
    expect(await readValue()).toEqual({ version: "2.0.0", limit: 7, authenticated: true });
    const rolledBack = await manager.rollback(manifest.id, updated.revision);
    expect(rolledBack).toMatchObject({
      commit: firstCommit,
      previousCommit: secondCommit,
      revision: 3,
      manifest: { version: "1.0.0" },
    });
    review = await manager.getBot(manifest.id, botId);
    expect(review.needsReview).toBe(true);
    await manager.saveBot(manifest.id, botId, {
      expectedRevision: review.revision,
      manifestHash: review.manifestHash,
      configuration: { values: {} },
    });
    expect(await readValue()).toEqual({ version: "1.0.0", limit: 7, authenticated: true });
    await old.dispose();
  });

  it("rejects stale version/configuration mutations without changing the winning state", async () => {
    await gitFixtures({ ...manifest, version: "2.0.0" });
    const installed = await manager.install({
      repository,
      commit: firstCommit,
      trustHostAccess: true,
    });
    const first = await enable();
    const second = await manager.saveBot(manifest.id, botId, {
      expectedRevision: first.revision,
      manifestHash: first.manifestHash,
      configuration: { values: { limit: 9 } },
    });
    await expect(
      manager.saveBot(manifest.id, botId, {
        expectedRevision: first.revision,
        manifestHash: first.manifestHash,
        enabled: false,
      }),
    ).rejects.toMatchObject({ code: "stale_revision" });
    expect((await manager.getBot(manifest.id, botId)).revision).toBe(second.revision);
    const updated = await manager.update(manifest.id, secondCommit, installed.revision);
    await expect(manager.rollback(manifest.id, installed.revision)).rejects.toMatchObject({
      code: "stale_revision",
    });
    await expect(manager.uninstall(manifest.id, installed.revision)).rejects.toMatchObject({
      code: "stale_revision",
    });
    await expect(
      manager.update(manifest.id, firstCommit, installed.revision),
    ).rejects.toMatchObject({ code: "stale_revision" });
    expect(await manager.list()).toEqual([updated]);
  });

  it("uninstalls globally, stops every Bot session and retains encrypted drafts for a disabled reinstall", async () => {
    const installed = await installBuiltin();
    await enable();
    await enable(otherBotId);
    const first = await manager.createSession(actor());
    const second = await manager.createSession(actor(otherBotId));
    await manager.uninstall(manifest.id, installed.revision);
    for (const session of [first, second])
      await expect(session.tools[0]!.execute({}, new AbortController().signal)).rejects.toThrow();
    expect(execute).not.toHaveBeenCalled();
    expect(dispose).toHaveBeenCalledTimes(2);
    expect(
      await connection.client`SELECT id FROM plugin_installations WHERE is_installed=true`,
    ).toHaveLength(0);
    const configurations =
      await connection.client`SELECT enabled, encrypted_secrets, values FROM bot_plugin_configs`;
    expect(configurations).toHaveLength(2);
    expect(
      configurations.every(
        (row) =>
          row.enabled === false &&
          typeof row.encrypted_secrets.cookie === "string" &&
          row.values.limit === 7,
      ),
    ).toBe(true);
    expect(JSON.stringify(configurations)).not.toContain("synthetic-cookie");
    await expect(manager.getBot(manifest.id, botId)).rejects.toMatchObject({ code: "not_found" });
    const reinstalled = await installBuiltin();
    expect(reinstalled.revision).toBeGreaterThan(installed.revision);
    await expect(manager.uninstall(manifest.id, installed.revision)).rejects.toMatchObject({
      code: "stale_revision",
    });
    expect(await manager.getBot(manifest.id, botId)).toMatchObject({
      enabled: false,
      configuration: { configuredSecrets: ["cookie"], values: { limit: 7 } },
    });
    expect((await manager.createSession(actor())).tools).toHaveLength(0);
    await first.dispose();
    await second.dispose();
    expect(dispose).toHaveBeenCalledTimes(2);
  });

  it("a concurrent save cannot re-enable a plugin after another manager commits uninstall", async () => {
    const installed = await installBuiltin();
    const saved = await enable();
    const other = new PluginManager(connection.db, encryptionKey, artifacts, [
      { manifest, definition },
    ]);
    const blocker = createDb(url);
    let writes: Promise<PromiseSettledResult<unknown>[]> | undefined;
    let uninstalling: Promise<void> | undefined;
    await connection.client.unsafe(`
      CREATE FUNCTION hold_manager_config_write() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN PERFORM pg_advisory_xact_lock(134763782); RETURN NEW; END $$;
      CREATE TRIGGER hold_manager_config_write BEFORE UPDATE ON bot_plugin_configs
      FOR EACH ROW EXECUTE FUNCTION hold_manager_config_write();
    `);
    async function waitForLock(table: string) {
      const deadline = Date.now() + 3000;
      while (Date.now() < deadline) {
        const [waiting] = await connection.client`
          SELECT count(*)::integer AS count FROM pg_stat_activity
          WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE ${`%${table}%`}
        `;
        if (waiting!.count >= 1) return;
        await delay(10);
      }
      throw new Error("Concurrent mutation must reach its expected database lock");
    }
    try {
      await blocker.client.begin(async (transaction) => {
        await transaction.unsafe("SELECT pg_advisory_xact_lock(134763782)");
        uninstalling = manager.uninstall(manifest.id, installed.revision);
        // Uninstall holds the installation row while its config UPDATE waits on this test lock.
        await waitForLock("bot_plugin_configs");
        writes = Promise.allSettled([
          uninstalling,
          other.saveBot(manifest.id, botId, {
            expectedRevision: saved.revision,
            manifestHash: saved.manifestHash,
            enabled: true,
          }),
        ]);
        await waitForLock("plugin_installations");
      });
      const results = await writes!;
      expect(results[0]).toMatchObject({ status: "fulfilled" });
      expect(results[1]).toMatchObject({ status: "rejected", reason: { code: "not_found" } });
      const [stored] =
        await connection.client`SELECT enabled, revision FROM bot_plugin_configs WHERE bot_id=${botId}`;
      expect(stored).toMatchObject({ enabled: false, revision: saved.revision + 1 });
    } finally {
      if (writes) await writes;
      else if (uninstalling) await uninstalling.catch(() => undefined);
      await blocker.client.end();
      await other.close();
      await connection.client.unsafe(
        `DROP TRIGGER hold_manager_config_write ON bot_plugin_configs; DROP FUNCTION hold_manager_config_write();`,
      );
    }
  });

  it("disabling aborts a pending session factory before it resolves and disposes its late result", async () => {
    const started = deferred<AbortSignal>();
    const finished = deferred<PluginSession>();
    definition.createSession = async (context) => {
      started.resolve(context.signal);
      return finished.promise;
    };
    await installBuiltin();
    const saved = await enable();
    const pending = manager.createSession(actor());
    const signal = await started.promise;
    await manager.saveBot(manifest.id, botId, {
      expectedRevision: saved.revision,
      manifestHash: saved.manifestHash,
      enabled: false,
    });
    expect(signal.aborted).toBe(true);
    finished.resolve({ dispose });
    expect((await pending).tools).toHaveLength(0);
    await vi.waitFor(() => expect(dispose).toHaveBeenCalledOnce());
  });

  it.each(["save", "close"] as const)(
    "%s aborts a pending plugin configuration check",
    async (action) => {
      const started = deferred<AbortSignal>();
      const finished = deferred<{ success: boolean }>();
      definition.check = async (context) => {
        started.resolve(context.signal);
        return finished.promise;
      };
      await installBuiltin();
      const saved = await enable();
      const checking = manager.checkBot(manifest.id, botId);
      const signal = await started.promise;
      if (action === "close") await manager.close();
      else
        await manager.saveBot(manifest.id, botId, {
          expectedRevision: saved.revision,
          manifestHash: saved.manifestHash,
          enabled: false,
        });
      expect(signal.aborted).toBe(true);
      finished.resolve({ success: true });
      expect(await checking).toEqual({ success: false });
    },
  );

  it("close waits for a session already being disposed and never calls its disposer twice", async () => {
    const started = deferred<void>();
    const released = deferred<void>();
    dispose.mockImplementation(async () => {
      started.resolve();
      await released.promise;
    });
    await installBuiltin();
    await enable();
    const active = await manager.createSession(actor());
    const disposing = active.dispose();
    await started.promise;
    let closed = false;
    const closing = manager.close().then(() => {
      closed = true;
    });
    try {
      await nextTurn();
      expect(closed).toBe(false);
      expect(dispose).toHaveBeenCalledOnce();
    } finally {
      released.resolve();
      await disposing;
      await closing;
    }
    expect(closed).toBe(true);
    expect(dispose).toHaveBeenCalledOnce();
  });

  it("closing aborts a pending Git install and drains queued mutations without persisting either", async () => {
    const started = deferred<AbortSignal>();
    vi.spyOn(artifacts, "stage").mockImplementation(async (source, signal) => {
      if (!signal) throw new Error("Install must propagate shutdown cancellation");
      started.resolve(signal);
      return new Promise((resolve) =>
        signal.addEventListener(
          "abort",
          () =>
            resolve({ repository: source.repository, commit: source.commit, manifest, directory }),
          { once: true },
        ),
      );
    });
    const installing = manager
      .install({ repository, commit: firstCommit, trustHostAccess: true })
      .then(
        (value) => ({ value }),
        (error) => ({ error }),
      );
    const signal = await started.promise;
    const queued = installBuiltin().then(
      (value) => ({ value }),
      (error) => ({ error }),
    );
    await manager.close();
    expect(signal.aborted).toBe(true);
    expect(await installing).toHaveProperty("error");
    expect(await queued).toMatchObject({ error: { code: "plugin_stopped" } });
    expect(await connection.client`SELECT id FROM plugin_installations`).toHaveLength(0);
    await expect(installBuiltin()).rejects.toMatchObject({ code: "plugin_stopped" });
  });

  it("returns safe runtime diagnostics when trusted plugin code throws private exception contents", async () => {
    definition.createSession = async () => {
      throw new Error("synthetic-private-cookie");
    };
    definition.check = async () => {
      throw new Error("synthetic-private-cookie");
    };
    await installBuiltin();
    await enable();
    expect((await manager.createSession(actor())).tools).toHaveLength(0);
    expect(await manager.getBot(manifest.id, botId)).toMatchObject({
      runtime: { status: "error", error: "plugin_failed" },
    });
    expect(await manager.checkBot(manifest.id, botId)).toEqual({ success: false });
    expect(JSON.stringify(await manager.getBot(manifest.id, botId))).not.toContain(
      "synthetic-private-cookie",
    );
  });
});
