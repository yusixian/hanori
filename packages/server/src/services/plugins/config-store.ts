import { createHash } from "node:crypto";
import { botPluginConfigs, bots, type Database } from "@cos-tool-bot/database";
import {
  parsePluginManifest,
  type PluginConfiguration,
  type PluginConfigPublic,
  type PluginConfigUpdate,
  type PluginManifest,
} from "@cos-tool-bot/shared";
import { and, eq } from "drizzle-orm";
import { PluginConfigCodec, publicStoredPluginConfig } from "./config.js";

export interface PluginConfigState {
  configuration: PluginConfigPublic;
  revision: number;
  manifestHash: string;
  configuredVersion: string | null;
  /** Desired state only. A runtime manager must separately report the applied revision. */
  enabled: boolean;
  needsReview: boolean;
  updatedAt: string | null;
}

export interface PluginConfigSave {
  expectedRevision: number;
  manifestHash: string;
  /** Omit for a pure enable/disable operation. Disabling never decrypts existing secrets. */
  configuration?: PluginConfigUpdate;
  enabled?: boolean;
}

export class PluginConfigStoreError extends Error {
  constructor(
    readonly code:
      | "not_found"
      | "stale_revision"
      | "manifest_changed"
      | "invalid_revision"
      | "invalid_update",
  ) {
    super(`Plugin configuration failed: ${code}`);
    this.name = "PluginConfigStoreError";
  }
}

type ConfigRow = typeof botPluginConfigs.$inferSelect;
const emptyConfig = { values: {}, encryptedSecrets: {} };

function manifestSnapshot(manifest: PluginManifest) {
  const parsed = parsePluginManifest(manifest);
  const hash = createHash("sha256").update(JSON.stringify(parsed)).digest("hex");
  return { manifest: parsed, hash };
}

function publicState(manifest: PluginManifest, hash: string, row?: ConfigRow): PluginConfigState {
  return {
    configuration: publicStoredPluginConfig(manifest, row ?? emptyConfig),
    revision: row?.revision ?? 0,
    manifestHash: hash,
    configuredVersion: row?.manifestVersion ?? null,
    enabled: row?.enabled ?? false,
    needsReview: row !== undefined && row.manifestHash !== hash,
    updatedAt: row?.updatedAt.toISOString() ?? null,
  };
}

/** Callers authorize the Bot and pin the installed manifest before entering this module.
 * Saving persists a desired configuration; it never executes, installs or reloads a plugin.
 */
export class PluginConfigStore {
  private readonly codec: PluginConfigCodec;

  constructor(
    private readonly db: Pick<Database, "select" | "insert" | "update">,
    encryptionKey: string,
  ) {
    this.codec = new PluginConfigCodec(encryptionKey);
  }

  private async read(botId: string, pluginId: string) {
    const [bot] = await this.db.select({ id: bots.id }).from(bots).where(eq(bots.id, botId));
    if (!bot) throw new PluginConfigStoreError("not_found");
    const [row] = await this.db
      .select()
      .from(botPluginConfigs)
      .where(and(eq(botPluginConfigs.botId, botId), eq(botPluginConfigs.pluginId, pluginId)));
    return row;
  }

  async get(botId: string, manifest: PluginManifest): Promise<PluginConfigState> {
    const snapshot = manifestSnapshot(manifest);
    const row = await this.read(botId, snapshot.manifest.id);
    return publicState(snapshot.manifest, snapshot.hash, row);
  }

  async save(
    botId: string,
    manifest: PluginManifest,
    change: PluginConfigSave,
  ): Promise<PluginConfigState> {
    if (
      !Number.isSafeInteger(change.expectedRevision) ||
      change.expectedRevision < 0 ||
      change.expectedRevision >= 2_147_483_647
    )
      throw new PluginConfigStoreError("invalid_revision");
    if (
      (change.enabled !== undefined && typeof change.enabled !== "boolean") ||
      (change.enabled === undefined && change.configuration === undefined)
    )
      throw new PluginConfigStoreError("invalid_update");
    const onlyDisable = change.enabled === false && change.configuration === undefined;
    const snapshot = manifestSnapshot(manifest);
    if (!onlyDisable && change.manifestHash !== snapshot.hash)
      throw new PluginConfigStoreError("manifest_changed");
    const row = await this.read(botId, snapshot.manifest.id);
    if ((row?.revision ?? 0) !== change.expectedRevision)
      throw new PluginConfigStoreError("stale_revision");
    if (
      !onlyDisable &&
      change.configuration === undefined &&
      row &&
      row.manifestHash !== snapshot.hash
    )
      throw new PluginConfigStoreError("manifest_changed");
    const enabled = change.enabled ?? row?.enabled ?? false;
    const stored = onlyDisable
      ? (row ?? emptyConfig)
      : this.codec.update(
          snapshot.manifest,
          { botId, pluginId: snapshot.manifest.id },
          row ?? emptyConfig,
          change.configuration ?? { values: {} },
          enabled,
        );
    const values = {
      values: stored.values,
      encryptedSecrets: stored.encryptedSecrets,
      manifestVersion: onlyDisable && row ? row.manifestVersion : snapshot.manifest.version,
      manifestHash: onlyDisable && row ? row.manifestHash : snapshot.hash,
      enabled,
      revision: change.expectedRevision + 1,
      updatedAt: new Date(),
    };
    const [saved] = row
      ? await this.db
          .update(botPluginConfigs)
          .set(values)
          .where(
            and(
              eq(botPluginConfigs.botId, botId),
              eq(botPluginConfigs.pluginId, snapshot.manifest.id),
              eq(botPluginConfigs.revision, change.expectedRevision),
            ),
          )
          .returning()
      : await this.db
          .insert(botPluginConfigs)
          .values({ botId, pluginId: snapshot.manifest.id, ...values })
          .onConflictDoNothing({ target: [botPluginConfigs.botId, botPluginConfigs.pluginId] })
          .returning();
    if (!saved) throw new PluginConfigStoreError("stale_revision");
    return publicState(snapshot.manifest, snapshot.hash, saved);
  }

  /** Decrypt only for an enabled, reviewed manifest in the authorized runtime. Never serialize this to HTTP. */
  async runtime(
    botId: string,
    manifest: PluginManifest,
  ): Promise<{ revision: number; configuration: PluginConfiguration } | null> {
    const snapshot = manifestSnapshot(manifest);
    const row = await this.read(botId, snapshot.manifest.id);
    if (!row?.enabled) return null;
    if (row.manifestHash !== snapshot.hash) throw new PluginConfigStoreError("manifest_changed");
    return {
      revision: row.revision,
      configuration: this.codec.runtime(
        snapshot.manifest,
        { botId, pluginId: snapshot.manifest.id },
        row,
      ),
    };
  }
}
