import { describe, expect, it } from "vitest";
import { parsePluginManifest } from "@cos-tool-bot/shared";
import { encrypt } from "../../utils/crypto.js";
import {
  PluginConfigCodec,
  PluginSecretError,
  publicStoredPluginConfig,
  type StoredPluginConfig,
} from "./config.js";

const key = "synthetic-plugin-config-key";
const codec = new PluginConfigCodec(key);
const scope = { botId: "test-bot-a", pluginId: "fixture.media" };
const empty: StoredPluginConfig = { values: {}, encryptedSecrets: {} };
const manifest = parsePluginManifest({
  apiVersion: 1,
  id: scope.pluginId,
  name: "Media fixture",
  version: "1.0.0",
  description: "Fixture only",
  author: "Tests",
  config: [
    { key: "cookie", type: "text", label: "Cookie", secret: true, required: true },
    { key: "token", type: "string", label: "Token", secret: true },
    { key: "limit", type: "integer", label: "Limit", default: 5 },
    { key: "enabled", type: "boolean", label: "Enabled", default: false },
    { key: "endpoint", type: "string", label: "Endpoint" },
  ],
});

function configured(): StoredPluginConfig {
  return codec.update(manifest, scope, empty, {
    values: { limit: 0 },
    secrets: { cookie: "test-cookie=synthetic-secret", token: "synthetic-token" },
  });
}

describe("plugin credential codec", () => {
  it("encrypts secrets at rest and projects only configured flags", () => {
    const stored = configured();
    expect(JSON.stringify(stored)).not.toContain("synthetic-secret");
    expect(JSON.stringify(stored)).not.toContain("synthetic-token");
    expect(stored.values).toEqual({ limit: 0, enabled: false });
    expect(publicStoredPluginConfig(manifest, stored)).toEqual({
      values: { limit: 0, enabled: false },
      configuredSecrets: ["cookie", "token"],
    });
    expect(codec.runtime(manifest, scope, stored)).toEqual({
      cookie: "test-cookie=synthetic-secret",
      token: "synthetic-token",
      limit: 0,
      enabled: false,
    });
  });

  it("preserves blank credentials, replaces nonblank ones and explicitly clears", () => {
    const stored = configured();
    const kept = codec.update(manifest, scope, stored, { values: {}, secrets: { cookie: "" } });
    expect(kept).toEqual(stored);
    const updated = codec.update(manifest, scope, stored, {
      values: {},
      secrets: { cookie: "replacement", token: null },
    });
    expect(codec.runtime(manifest, scope, updated).cookie).toBe("replacement");
    expect(updated.encryptedSecrets).not.toHaveProperty("token");
    expect(updated.encryptedSecrets.cookie).not.toBe(stored.encryptedSecrets.cookie);
  });

  it("allows incomplete drafts but rejects enabling one", () => {
    const draft = codec.update(manifest, scope, empty, { values: {} });
    expect(publicStoredPluginConfig(manifest, draft).configuredSecrets).toEqual([]);
    expect(() => codec.runtime(manifest, scope, draft)).toThrow("Required configuration field");
    expect(() => codec.update(manifest, scope, empty, { values: {} }, true)).toThrow();
  });

  it("never exposes or executes an old secret reclassified as ordinary configuration", () => {
    const upgraded = parsePluginManifest({
      ...manifest,
      version: "2.0.0",
      config: manifest.config.map((field) =>
        field.key === "cookie" ? { ...field, secret: false, required: false } : field,
      ),
    });
    const stored = configured();
    stored.values.cookie = "also-sensitive-malformed-duplicate";
    expect(publicStoredPluginConfig(upgraded, stored).values).not.toHaveProperty("cookie");
    expect(codec.runtime(upgraded, scope, stored)).not.toHaveProperty("cookie");
    const saved = codec.update(upgraded, scope, stored, { values: { cookie: "new-public-value" } });
    expect(saved.encryptedSecrets).not.toHaveProperty("cookie");
    expect(publicStoredPluginConfig(upgraded, saved).values.cookie).toBe("new-public-value");
  });

  it("requires a new credential when a previously ordinary field becomes secret", () => {
    const upgraded = parsePluginManifest({
      ...manifest,
      config: manifest.config.map((field) =>
        field.key === "endpoint" ? { ...field, secret: true, required: true } : field,
      ),
    });
    const stored = configured();
    stored.values.endpoint = "previously-public";
    expect(publicStoredPluginConfig(upgraded, stored).values).not.toHaveProperty("endpoint");
    expect(publicStoredPluginConfig(upgraded, stored).configuredSecrets).not.toContain("endpoint");
    expect(() => codec.runtime(upgraded, scope, stored)).toThrow("Required configuration field");
  });

  it("binds credentials to their Bot, plugin and field while allowing version upgrades", () => {
    const stored = configured();
    expect(() => codec.runtime(manifest, { ...scope, botId: "test-bot-b" }, stored)).toThrow(
      PluginSecretError,
    );
    const otherPlugin = { ...manifest, id: "fixture.other" };
    expect(() =>
      codec.runtime(otherPlugin, { ...scope, pluginId: otherPlugin.id }, stored),
    ).toThrow(PluginSecretError);
    expect(() =>
      codec.runtime(manifest, scope, {
        ...stored,
        encryptedSecrets: { cookie: stored.encryptedSecrets.token! },
      }),
    ).toThrow(PluginSecretError);
    expect(() => codec.runtime({ ...manifest, version: "2.0.0" }, scope, stored)).not.toThrow();
    expect(() => codec.runtime(otherPlugin, scope, empty)).toThrow(PluginSecretError);
  });

  it("fails closed on corrupted or wrong-key secrets with a safe error", () => {
    const stored = configured();
    expect(() => new PluginConfigCodec("wrong-key").runtime(manifest, scope, stored)).toThrow(
      PluginSecretError,
    );
    for (const ciphertext of [
      "raw-synthetic-secret",
      encrypt("sensitive-invalid-json", key),
      `${stored.encryptedSecrets.cookie}:extra`,
    ]) {
      const corrupt = { ...stored, encryptedSecrets: { cookie: ciphertext } };
      expect(() => codec.runtime(manifest, scope, corrupt)).toThrow(new PluginSecretError());
      expect(publicStoredPluginConfig(manifest, corrupt).configuredSecrets).toEqual(["cookie"]);
    }
  });

  it("can repair corrupt credentials by replacement or removal without decrypting them", () => {
    const corrupt = { ...empty, encryptedSecrets: { cookie: "invalid-cipher" } };
    expect(() => codec.update(manifest, scope, corrupt, { values: {} })).toThrow(PluginSecretError);
    const repaired = codec.update(manifest, scope, corrupt, {
      values: {},
      secrets: { cookie: "repaired" },
    });
    expect(codec.runtime(manifest, scope, repaired).cookie).toBe("repaired");
    expect(
      codec.update(manifest, scope, corrupt, { values: {}, secrets: { cookie: null } })
        .encryptedSecrets,
    ).toEqual({});
  });

  it("discards removed fields and resets ordinary values to defaults", () => {
    const stored = configured();
    stored.values.obsolete = "old";
    stored.encryptedSecrets.obsoleteSecret = "unreadable-removed-secret";
    const saved = codec.update(manifest, scope, stored, { values: { limit: null } });
    expect(saved.values).toEqual({ limit: 5, enabled: false });
    expect(Object.keys(saved.encryptedSecrets)).toEqual(["cookie", "token"]);
  });

  it("validates credentials against the current manifest without leaking rejected contents", () => {
    const upgraded = parsePluginManifest({
      ...manifest,
      config: manifest.config.map((field) =>
        field.key === "cookie" ? { ...field, max: 3 } : field,
      ),
    });
    expect(() => codec.runtime(upgraded, scope, configured())).toThrow(
      "Invalid configuration value",
    );
    expect(() =>
      codec.update(manifest, scope, empty, { values: { cookie: "wrong-channel" } }),
    ).toThrow("Unknown or secret");
    expect(() => new PluginConfigCodec("")).toThrow("encryption key is required");
  });
});
