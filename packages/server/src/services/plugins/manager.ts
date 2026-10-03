import { pathToFileURL } from "node:url";
import { join } from "node:path";
import { botPluginConfigs, pluginInstallations, type Database } from "@cos-tool-bot/database";
import {
  parsePluginManifest,
  type PluginActor,
  type PluginBotState,
  type PluginBotUpdate,
  type PluginCatalogEntry,
  type PluginDefinition,
  type PluginInstallRequest,
  type PluginLoginStart,
  type PluginManifest,
  type PluginRuntimePort,
  type PluginSession,
  type PluginTurnSession,
} from "@cos-tool-bot/shared";
import { and, eq, sql } from "drizzle-orm";
import { PluginConfigStore, PluginConfigStoreError } from "./config-store.js";
import { PluginLoginService } from "./login.js";
import { GitPluginArtifacts } from "./git-artifacts.js";
import {
  bindPluginSession,
  PluginRuntimeError,
  runPluginCall,
  validatePluginDefinition,
  validatePluginSession,
} from "./runtime.js";

export interface BuiltinPlugin {
  manifest: PluginManifest;
  definition: PluginDefinition;
}
type Installation = typeof pluginInstallations.$inferSelect;

export class PluginManagerError extends Error {
  constructor(
    readonly code:
      | "not_found"
      | "already_installed"
      | "stale_revision"
      | "invalid_installation"
      | "plugin_limit"
      | "rollback_unavailable",
  ) {
    super(code);
    this.name = "PluginManagerError";
  }
}

interface ActiveSession {
  botId: string;
  pluginId: string;
  stop(): Promise<void>;
}

/** Instance installations and Bot configuration are independent; every invocation checks both. */
export class PluginManager implements PluginRuntimePort {
  private readonly configs: PluginConfigStore;
  private readonly definitions = new Map<string, Promise<PluginDefinition>>();
  private readonly active = new Set<ActiveSession>();
  private readonly runtimeErrors = new Map<string, string>();
  private mutation: Promise<unknown> = Promise.resolve();
  private stopped = false;
  private readonly shutdown = new AbortController();
  readonly logins: PluginLoginService;
  private configurationChanged?: (pluginId: string, botId?: string) => Promise<void>;

  constructor(
    private readonly db: Database,
    private readonly encryptionKey: string,
    private readonly artifacts: GitPluginArtifacts,
    private readonly builtins: readonly BuiltinPlugin[],
  ) {
    this.configs = new PluginConfigStore(db, encryptionKey);
    this.logins = new PluginLoginService({
      open: (id, botId, start, signal) => this.openLogin(id, botId, start, signal),
    });
  }

  onConfigurationChanged(callback: (pluginId: string, botId?: string) => Promise<void>) {
    this.configurationChanged = callback;
  }

  /** Host-only access for durable jobs. Never serialize this value to management HTTP. */
  async runtimeConfiguration(id: string, botId: string) {
    let row: Installation;
    try {
      row = await this.installed(id);
    } catch {
      return null;
    }
    const state = await this.configs.runtime(botId, this.manifest(row));
    return state ? { ...state, installationRevision: row.revision } : null;
  }

  private serial<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.mutation
      .catch(() => undefined)
      .then(() => {
        if (this.stopped) throw new PluginRuntimeError("plugin_stopped");
        return operation();
      });
    this.mutation = result.catch(() => undefined);
    return result;
  }

  private manifest(row: Installation): PluginManifest {
    if (row.source === "builtin") {
      const builtin = this.builtins.find((entry) => entry.manifest.id === row.id);
      if (!builtin) throw new PluginManagerError("not_found");
      return parsePluginManifest(builtin.manifest);
    }
    return parsePluginManifest(row.manifest);
  }

  private record(row: Installation): PluginCatalogEntry {
    return {
      manifest: this.manifest(row),
      source: row.source,
      installed: true,
      repository: row.repository,
      commit: row.commit,
      previousCommit: row.previousCommit,
      revision: row.revision,
    };
  }

  private async installed(id: string) {
    const [row] = await this.db
      .select()
      .from(pluginInstallations)
      .where(and(eq(pluginInstallations.id, id), eq(pluginInstallations.isInstalled, true)));
    if (!row) throw new PluginManagerError("not_found");
    return row;
  }

  async list(): Promise<PluginCatalogEntry[]> {
    const rows = await this.db
      .select()
      .from(pluginInstallations)
      .where(eq(pluginInstallations.isInstalled, true));
    const installed = new Set(rows.map((row) => row.id));
    return [
      ...rows.map((row) => this.record(row)),
      ...this.builtins
        .filter((entry) => !installed.has(entry.manifest.id))
        .map(
          (entry): PluginCatalogEntry => ({
            manifest: parsePluginManifest(entry.manifest),
            source: "builtin",
            installed: false,
            repository: null,
            commit: null,
            previousCommit: null,
            revision: 0,
          }),
        ),
    ].sort((a, b) => a.manifest.id.localeCompare(b.manifest.id));
  }

  async install(request: PluginInstallRequest, signal?: AbortSignal): Promise<PluginCatalogEntry> {
    if (request.trustHostAccess !== true) throw new PluginManagerError("invalid_installation");
    signal = signal ? AbortSignal.any([signal, this.shutdown.signal]) : this.shutdown.signal;
    return this.serial(async () => {
      if (
        (
          await this.db
            .select({ id: pluginInstallations.id })
            .from(pluginInstallations)
            .where(eq(pluginInstallations.isInstalled, true))
        ).length >= 32
      )
        throw new PluginManagerError("plugin_limit");
      const builtin =
        "builtinId" in request
          ? this.builtins.find((entry) => entry.manifest.id === request.builtinId)
          : undefined;
      if ("builtinId" in request && !builtin) throw new PluginManagerError("not_found");
      const staged =
        "repository" in request ? await this.artifacts.stage(request, signal) : undefined;
      const manifest = parsePluginManifest(builtin?.manifest ?? staged?.manifest);
      signal?.throwIfAborted();
      const values = {
        id: manifest.id,
        source: builtin ? ("builtin" as const) : ("git" as const),
        repository: staged?.repository ?? null,
        commit: staged?.commit ?? null,
        manifest,
        isInstalled: true,
      };
      const [row] = await this.db
        .insert(pluginInstallations)
        .values(values)
        .onConflictDoUpdate({
          target: pluginInstallations.id,
          set: {
            ...values,
            previousCommit: null,
            previousManifest: null,
            revision: sql`${pluginInstallations.revision} + 1`,
            updatedAt: new Date(),
          },
          setWhere: eq(pluginInstallations.isInstalled, false),
        })
        .returning();
      if (!row) throw new PluginManagerError("already_installed");
      return this.record(row);
    });
  }

  async update(
    id: string,
    commit: string,
    expectedRevision: number,
    signal?: AbortSignal,
  ): Promise<PluginCatalogEntry> {
    signal = signal ? AbortSignal.any([signal, this.shutdown.signal]) : this.shutdown.signal;
    return this.serial(async () => {
      const row = await this.installed(id);
      this.checkRevision(row, expectedRevision);
      if (row.source !== "git" || !row.repository || commit === row.commit)
        throw new PluginManagerError("invalid_installation");
      const staged = await this.artifacts.stage({ repository: row.repository, commit }, signal);
      if (staged.manifest.id !== id) throw new PluginManagerError("invalid_installation");
      signal?.throwIfAborted();
      const [saved] = await this.db
        .update(pluginInstallations)
        .set({
          commit: staged.commit,
          manifest: staged.manifest,
          previousCommit: row.commit,
          previousManifest: row.manifest,
          revision: row.revision + 1,
          updatedAt: new Date(),
        })
        .where(
          and(eq(pluginInstallations.id, id), eq(pluginInstallations.revision, expectedRevision)),
        )
        .returning();
      if (!saved) throw new PluginManagerError("stale_revision");
      this.logins.invalidate(id);
      await this.stopSessions(id);
      await this.configurationChanged?.(id);
      return this.record(saved);
    });
  }

  async rollback(id: string, expectedRevision: number): Promise<PluginCatalogEntry> {
    return this.serial(async () => {
      const row = await this.installed(id);
      this.checkRevision(row, expectedRevision);
      if (row.source !== "git" || !row.previousCommit || !row.previousManifest)
        throw new PluginManagerError("rollback_unavailable");
      const previous = await this.artifacts.locate(id, row.previousCommit);
      if (
        JSON.stringify(previous.manifest) !==
        JSON.stringify(parsePluginManifest(row.previousManifest))
      )
        throw new PluginManagerError("invalid_installation");
      const [saved] = await this.db
        .update(pluginInstallations)
        .set({
          commit: row.previousCommit,
          manifest: row.previousManifest,
          previousCommit: row.commit,
          previousManifest: row.manifest,
          revision: row.revision + 1,
          updatedAt: new Date(),
        })
        .where(
          and(eq(pluginInstallations.id, id), eq(pluginInstallations.revision, expectedRevision)),
        )
        .returning();
      if (!saved) throw new PluginManagerError("stale_revision");
      this.logins.invalidate(id);
      await this.stopSessions(id);
      await this.configurationChanged?.(id);
      return this.record(saved);
    });
  }

  async uninstall(id: string, expectedRevision: number): Promise<void> {
    return this.serial(async () => {
      const row = await this.installed(id);
      this.checkRevision(row, expectedRevision);
      await this.db.transaction(async (tx) => {
        const deleted = await tx
          .update(pluginInstallations)
          .set({ isInstalled: false, revision: row.revision + 1, updatedAt: new Date() })
          .where(
            and(eq(pluginInstallations.id, id), eq(pluginInstallations.revision, expectedRevision)),
          )
          .returning({ id: pluginInstallations.id });
        if (!deleted.length) throw new PluginManagerError("stale_revision");
        await tx
          .update(botPluginConfigs)
          .set({
            enabled: false,
            revision: sql`${botPluginConfigs.revision} + 1`,
            updatedAt: new Date(),
          })
          .where(eq(botPluginConfigs.pluginId, id));
      });
      this.logins.invalidate(id);
      await this.stopSessions(id);
      await this.configurationChanged?.(id);
      // Retain immutable artifacts and encrypted drafts for a recoverable reinstall.
    });
  }

  private checkRevision(row: Installation, revision: number) {
    if (
      !Number.isSafeInteger(revision) ||
      revision < 1 ||
      revision >= 2_147_483_647 ||
      row.revision !== revision
    )
      throw new PluginManagerError("stale_revision");
  }

  private async definition(row: Installation): Promise<PluginDefinition> {
    if (row.source === "builtin")
      return validatePluginDefinition(
        this.builtins.find((entry) => entry.manifest.id === row.id)?.definition,
      );
    if (!row.commit) throw new PluginManagerError("invalid_installation");
    const key = `${row.id}:${row.commit}`;
    let loaded = this.definitions.get(key);
    if (!loaded) {
      loaded = (async () => {
        const artifact = await this.artifacts.locate(row.id, row.commit!);
        if (JSON.stringify(artifact.manifest) !== JSON.stringify(this.manifest(row)))
          throw new PluginManagerError("invalid_installation");
        const module = await import(pathToFileURL(join(artifact.directory, "index.mjs")).href);
        return validatePluginDefinition(module.default);
      })();
      this.definitions.set(key, loaded);
      loaded.catch(() => this.definitions.delete(key));
    }
    return loaded;
  }

  async getBot(id: string, botId: string): Promise<PluginBotState> {
    const row = await this.installed(id);
    const state = await this.configs.get(botId, this.manifest(row));
    let error = this.runtimeErrors.get(`${botId}:${id}`) ?? null;
    if (state.enabled && !state.needsReview) {
      try {
        await this.configs.runtime(botId, this.manifest(row));
        await runPluginCall(() => this.definition(row), new AbortController().signal, 10_000);
      } catch {
        error = "plugin_failed";
      }
    }
    return {
      ...state,
      runtime: {
        status: !state.enabled
          ? "disabled"
          : state.needsReview
            ? "needs_review"
            : error
              ? "error"
              : "ready",
        error,
      },
    };
  }

  async saveBot(id: string, botId: string, update: PluginBotUpdate): Promise<PluginBotState> {
    this.logins.invalidate(id, botId);
    return this.persistBot(id, botId, update);
  }

  private async persistBot(
    id: string,
    botId: string,
    update: PluginBotUpdate,
    login?: { installationRevision: number; signal: AbortSignal },
  ): Promise<PluginBotState> {
    return this.serial(async () => {
      login?.signal.throwIfAborted();
      await this.db.transaction(async (tx) => {
        if (login) {
          await tx.execute(sql`SET LOCAL statement_timeout = '15s'`);
          await tx.execute(sql`SET LOCAL lock_timeout = '10s'`);
        }
        const [row] = await tx
          .select()
          .from(pluginInstallations)
          .where(and(eq(pluginInstallations.id, id), eq(pluginInstallations.isInstalled, true)))
          .for("update");
        if (!row) throw new PluginManagerError("not_found");
        if (login) {
          this.checkRevision(row, login.installationRevision);
          login.signal.throwIfAborted();
        }
        await new PluginConfigStore(tx, this.encryptionKey).save(botId, this.manifest(row), update);
        login?.signal.throwIfAborted();
      });
      await this.stopSessions(id, botId);
      await this.configurationChanged?.(id, botId);
      this.runtimeErrors.delete(`${botId}:${id}`);
      return this.getBot(id, botId);
    });
  }

  private async openLogin(id: string, botId: string, start: PluginLoginStart, signal: AbortSignal) {
    if (this.stopped) throw new PluginRuntimeError("plugin_stopped");
    const row = await this.installed(id);
    const manifest = this.manifest(row);
    if (!manifest.login) throw new PluginManagerError("invalid_installation");
    const assertCurrent = async () => {
      signal.throwIfAborted();
      const current = await this.installed(id);
      this.checkRevision(current, row.revision);
      const state = await this.configs.get(botId, this.manifest(current));
      if (state.revision !== start.expectedRevision)
        throw new PluginConfigStoreError("stale_revision");
      if (state.needsReview || state.manifestHash !== start.manifestHash)
        throw new PluginConfigStoreError("manifest_changed");
      signal.throwIfAborted();
    };
    await assertCurrent();
    const definition = await this.definition(row);
    if (!definition.startLogin) throw new PluginManagerError("invalid_installation");
    signal.throwIfAborted();
    const attempt = await definition.startLogin(signal);
    return {
      attempt,
      assertCurrent,
      commit: (secrets: Record<string, string>, commitSignal: AbortSignal) =>
        this.persistBot(
          id,
          botId,
          { ...start, configuration: { values: {}, secrets } },
          { installationRevision: row.revision, signal: commitSignal },
        ),
    };
  }

  async checkBot(id: string, botId: string): Promise<{ success: boolean }> {
    const row = await this.installed(id);
    const state = await this.configs.runtime(botId, this.manifest(row));
    if (!state) return { success: false };
    const controller = new AbortController();
    const active: ActiveSession = {
      botId,
      pluginId: id,
      stop: async () => {
        controller.abort();
        this.active.delete(active);
      },
    };
    this.active.add(active);
    try {
      await this.assertCurrent(row, botId, state.revision);
      const definition = await runPluginCall(() => this.definition(row), controller.signal, 10_000);
      const context = {
        actor: { botId, chatId: 0, isAdmin: true, isPrivate: true, readOnly: true },
        configuration: Object.freeze(state.configuration),
        signal: controller.signal,
      };
      const result = await runPluginCall(
        async (signal) => {
          if (definition.check) return definition.check({ ...context, signal });
          const session = await definition.createSession({ ...context, signal });
          try {
            validatePluginSession(session);
            return { success: true };
          } finally {
            await session.dispose?.();
          }
        },
        controller.signal,
        15_000,
      );
      await this.assertCurrent(row, botId, state.revision);
      if (result.success === true) this.runtimeErrors.delete(`${botId}:${id}`);
      return { success: result.success === true };
    } catch {
      this.runtimeErrors.set(`${botId}:${id}`, "plugin_failed");
      return { success: false };
    } finally {
      await active.stop();
    }
  }

  private async assertCurrent(row: Installation, botId: string, revision: number): Promise<void> {
    if (this.stopped) throw new PluginRuntimeError("plugin_stopped");
    const installed = await this.installed(row.id);
    if (installed.revision !== row.revision || installed.commit !== row.commit)
      throw new PluginRuntimeError("plugin_stopped");
    const current = await this.configs.get(botId, this.manifest(installed));
    if (!current.enabled || current.needsReview || current.revision !== revision)
      throw new PluginRuntimeError("plugin_stopped");
  }

  async createSession(actor: PluginActor, signal?: AbortSignal): Promise<PluginTurnSession> {
    if (this.stopped) throw new PluginRuntimeError("plugin_stopped");
    const output: PluginTurnSession = {
      tools: [],
      searchProviders: [],
      dispose: async () => {
        await Promise.allSettled(created.map((entry) => entry.stop()));
      },
    };
    const created: ActiveSession[] = [];
    const rows = await this.db
      .select()
      .from(pluginInstallations)
      .where(eq(pluginInstallations.isInstalled, true));
    try {
      for (const row of rows) {
        signal?.throwIfAborted();
        const controller = new AbortController();
        const combined = signal ? AbortSignal.any([controller.signal, signal]) : controller.signal;
        let session: PluginSession | undefined;
        let disposed = false;
        let stopping: Promise<void> | undefined;
        const active: ActiveSession = {
          botId: actor.botId,
          pluginId: row.id,
          stop: async () => {
            if (!stopping) {
              disposed = true;
              controller.abort();
              stopping = (async () => {
                try {
                  if (session?.dispose)
                    await runPluginCall(
                      async () => {
                        await session!.dispose!();
                      },
                      new AbortController().signal,
                      5_000,
                    ).catch(() => undefined);
                } finally {
                  this.active.delete(active);
                }
              })();
            }
            await stopping;
          },
        };
        try {
          const state = await this.configs.runtime(actor.botId, this.manifest(row));
          if (!state) continue;
          this.active.add(active);
          created.push(active);
          await this.assertCurrent(row, actor.botId, state.revision);
          const definition = await runPluginCall(() => this.definition(row), combined, 10_000);
          session = await runPluginCall(
            async (boundedSignal) => {
              const value = await definition.createSession({
                actor: Object.freeze({ ...actor }),
                configuration: Object.freeze(state.configuration),
                signal: combined,
              });
              if (boundedSignal.aborted || disposed) {
                await runPluginCall(
                  async () => {
                    await value.dispose?.();
                  },
                  new AbortController().signal,
                  5_000,
                ).catch(() => undefined);
                throw new PluginRuntimeError("plugin_stopped");
              }
              return value;
            },
            combined,
            10_000,
          );
          await this.assertCurrent(row, actor.botId, state.revision);
          const bound = bindPluginSession({
            pluginId: row.id,
            session,
            actor,
            signal: combined,
            authorize: () => this.assertCurrent(row, actor.botId, state.revision),
          });
          if (combined.aborted) throw new PluginRuntimeError("plugin_stopped");
          output.tools = [...output.tools, ...bound.tools];
          output.searchProviders = [...output.searchProviders, ...bound.searchProviders];
          this.runtimeErrors.delete(`${actor.botId}:${row.id}`);
        } catch {
          await active.stop();
          this.runtimeErrors.set(`${actor.botId}:${row.id}`, "plugin_failed");
        }
      }
      signal?.throwIfAborted();
      return output;
    } catch (error) {
      await output.dispose();
      throw error;
    }
  }

  private async stopSessions(pluginId: string, botId?: string) {
    await Promise.allSettled(
      [...this.active]
        .filter(
          (entry) => entry.pluginId === pluginId && (botId === undefined || entry.botId === botId),
        )
        .map((entry) => entry.stop()),
    );
  }

  async close() {
    this.stopped = true;
    this.shutdown.abort();
    await this.logins.close();
    await Promise.allSettled([...this.active].map((entry) => entry.stop()));
    await this.mutation;
  }
}
