import {
  mergePluginConfig,
  type PluginConfigPublic,
  type PluginConfiguration,
  type PluginConfigUpdate,
  type PluginManifest,
} from "@cos-tool-bot/shared";
import { decrypt, encrypt } from "../../utils/crypto.js";

/** Keep the original sensitivity classification independently of future manifests. */
export interface StoredPluginConfig {
  values: PluginConfiguration;
  encryptedSecrets: Record<string, string>;
}

export interface PluginConfigScope {
  botId: string;
  pluginId: string;
}

export class PluginSecretError extends Error {
  constructor() {
    super("Plugin credentials cannot be read; replace or clear the affected credentials");
    this.name = "PluginSecretError";
  }
}

function ordinaryValues(manifest: PluginManifest, stored: StoredPluginConfig): PluginConfiguration {
  const values: PluginConfiguration = {};
  for (const field of manifest.config) {
    if (field.secret) continue;
    // A downgraded secret must never become public, even if a malformed row contains both.
    const value = Object.hasOwn(stored.encryptedSecrets, field.key)
      ? field.default
      : ((Object.hasOwn(stored.values, field.key) ? stored.values[field.key] : undefined) ??
        field.default);
    if (value !== undefined) values[field.key] = value;
  }
  return values;
}

/** This projection never decrypts a credential. */
export function publicStoredPluginConfig(
  manifest: PluginManifest,
  stored: StoredPluginConfig,
): PluginConfigPublic {
  return {
    values: ordinaryValues(manifest, stored),
    configuredSecrets: manifest.config
      .filter(
        (field) =>
          field.secret &&
          Object.hasOwn(stored.encryptedSecrets, field.key) &&
          !!stored.encryptedSecrets[field.key],
      )
      .map((field) => field.key),
  };
}

/** Use only behind a Bot-scoped, authorized service; this class is not an access control. */
export class PluginConfigCodec {
  constructor(private readonly encryptionKey: string) {
    if (!encryptionKey) throw new Error("Plugin credential encryption key is required");
  }

  private assertScope(manifest: PluginManifest, scope: PluginConfigScope): void {
    if (!scope.botId || manifest.id !== scope.pluginId) throw new PluginSecretError();
  }

  private readSecret(ciphertext: string, scope: PluginConfigScope, field: string): string {
    try {
      if (ciphertext.length > 262_144 || ciphertext.split(":").length !== 3)
        throw new PluginSecretError();
      const envelope: unknown = JSON.parse(decrypt(ciphertext, this.encryptionKey));
      if (
        envelope === null ||
        typeof envelope !== "object" ||
        !("kind" in envelope) ||
        envelope.kind !== "plugin-secret" ||
        !("version" in envelope) ||
        envelope.version !== 1 ||
        !("botId" in envelope) ||
        envelope.botId !== scope.botId ||
        !("pluginId" in envelope) ||
        envelope.pluginId !== scope.pluginId ||
        !("field" in envelope) ||
        envelope.field !== field ||
        !("value" in envelope) ||
        typeof envelope.value !== "string"
      ) {
        throw new PluginSecretError();
      }
      return envelope.value;
    } catch {
      // Crypto and JSON parser errors may contain credential material.
      throw new PluginSecretError();
    }
  }

  private currentValues(
    manifest: PluginManifest,
    scope: PluginConfigScope,
    stored: StoredPluginConfig,
    update?: PluginConfigUpdate,
  ): PluginConfiguration {
    this.assertScope(manifest, scope);
    const values = ordinaryValues(manifest, stored);
    for (const field of manifest.config) {
      if (!field.secret) continue;
      const replacement =
        update?.secrets && Object.hasOwn(update.secrets, field.key)
          ? update.secrets[field.key]
          : undefined;
      // Replacement/clear must recover a corrupted secret without first decrypting it.
      if (replacement === null || (typeof replacement === "string" && replacement !== "")) continue;
      const ciphertext = Object.hasOwn(stored.encryptedSecrets, field.key)
        ? stored.encryptedSecrets[field.key]
        : undefined;
      if (ciphertext) values[field.key] = this.readSecret(ciphertext, scope, field.key);
    }
    return values;
  }

  /** Return plaintext only for the trusted plugin runtime, never for an HTTP response. */
  runtime(
    manifest: PluginManifest,
    scope: PluginConfigScope,
    stored: StoredPluginConfig,
  ): PluginConfiguration {
    return mergePluginConfig(
      manifest,
      this.currentValues(manifest, scope, stored),
      { values: {} },
      true,
    );
  }

  update(
    manifest: PluginManifest,
    scope: PluginConfigScope,
    stored: StoredPluginConfig,
    update: PluginConfigUpdate,
    requireComplete = false,
  ): StoredPluginConfig {
    const current = this.currentValues(manifest, scope, stored, update);
    const merged = mergePluginConfig(manifest, current, update, requireComplete);
    const result: StoredPluginConfig = { values: {}, encryptedSecrets: {} };
    for (const field of manifest.config) {
      if (!Object.hasOwn(merged, field.key)) continue;
      const value = merged[field.key];
      if (value === undefined) continue;
      if (!field.secret) {
        result.values[field.key] = value;
        continue;
      }
      result.encryptedSecrets[field.key] =
        Object.hasOwn(current, field.key) &&
        current[field.key] === value &&
        Object.hasOwn(stored.encryptedSecrets, field.key) &&
        stored.encryptedSecrets[field.key]
          ? stored.encryptedSecrets[field.key]!
          : encrypt(
              JSON.stringify({
                kind: "plugin-secret",
                version: 1,
                ...scope,
                field: field.key,
                value,
              }),
              this.encryptionKey,
            );
    }
    return result;
  }
}
