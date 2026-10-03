import { describe, expect, it } from "vitest";
import { mergePluginConfig, parsePluginManifest, publicPluginConfig } from "./plugins.js";
import type { PluginConfigUpdate } from "./plugins.js";

const manifest = {
  apiVersion: 1,
  id: "hanori.example",
  name: "Example",
  description: "Synthetic plugin used by configuration tests",
  version: "1.0.0",
  author: "Hanori",
  config: [
    { key: "cookie", label: "Cookie", type: "text", secret: true, required: true },
    { key: "limit", label: "Limit", type: "integer", min: 1, max: 20, default: 5 },
    { key: "enabled", label: "Enabled", type: "boolean", default: false },
    {
      key: "language",
      label: "Language",
      type: "select",
      options: [{ value: "zh", label: "中文" }],
    },
  ],
};

describe("plugin configuration", () => {
  it("validates a manifest without retaining unknown executable or HTML metadata", () => {
    expect(parsePluginManifest({ ...manifest, html: "<script>test</script>" })).toEqual(manifest);
  });

  it("supports a generic QR login capability without retaining executable metadata", () => {
    expect(
      parsePluginManifest({ ...manifest, login: { type: "qr", script: "untrusted" } }).login,
    ).toEqual({ type: "qr" });
    for (const login of [null, "qr", {}, { type: "script" }]) {
      expect(() => parsePluginManifest({ ...manifest, login })).toThrow();
    }
  });

  it.each<PluginConfigUpdate>([
    { values: { cookie: "secret-in-plain-values" } },
    { values: { limit: 21 } },
    { values: { limit: 1.5 } },
    { values: { enabled: "true" } },
    { values: { language: "unsupported" } },
    { values: { unknown: "value" } },
    { values: {}, secrets: { limit: "wrong-channel" } },
  ])("rejects malformed updates without echoing input values", (update) => {
    expect(() => mergePluginConfig(parsePluginManifest(manifest), {}, update)).toThrow();
  });

  it.each([
    { ...manifest, apiVersion: 2 },
    { ...manifest, id: "../../example" },
    { ...manifest, homepage: "javascript:alert(1)" },
    { ...manifest, homepage: "https://name:password@example.com" },
    { ...manifest, config: [manifest.config[0], manifest.config[0]] },
    { ...manifest, config: [{ ...manifest.config[0], key: "constructor" }] },
    { ...manifest, config: [{ ...manifest.config[0], default: "embedded-secret" }] },
    { ...manifest, config: [{ ...manifest.config[1], min: 30 }] },
    { ...manifest, config: [{ ...manifest.config[0], max: 100_000 }] },
  ])("rejects incompatible, ambiguous, or unsafe metadata", (input) => {
    expect(() => parsePluginManifest(input)).toThrow();
  });

  it("returns only configured flags for secrets, including schema defaults for normal fields", () => {
    expect(
      publicPluginConfig(parsePluginManifest(manifest), { cookie: "test-secret", orphan: "old" }),
    ).toEqual({
      values: { limit: 5, enabled: false },
      configuredSecrets: ["cookie"],
    });
  });

  it("keeps blank secrets, replaces supplied values and clears explicitly without replaying unknown fields", () => {
    const parsed = parsePluginManifest(manifest);
    const current = { cookie: "old-secret", orphan: "old" };
    expect(
      mergePluginConfig(parsed, current, { values: { limit: 10 }, secrets: { cookie: "" } }),
    ).toEqual({
      cookie: "old-secret",
      limit: 10,
      enabled: false,
    });
    expect(
      mergePluginConfig(parsed, current, { values: {}, secrets: { cookie: "new-secret" } }).cookie,
    ).toBe("new-secret");
    expect(
      mergePluginConfig(parsed, current, { values: {}, secrets: { cookie: null } }),
    ).not.toHaveProperty("cookie");
  });

  it("allows an incomplete draft but requires configured credentials when enabled", () => {
    const parsed = parsePluginManifest(manifest);
    expect(mergePluginConfig(parsed, {}, { values: {} })).toEqual({ limit: 5, enabled: false });
    expect(() => mergePluginConfig(parsed, {}, { values: {} }, true)).toThrow(
      "Required configuration field is missing",
    );
    expect(() =>
      mergePluginConfig(parsed, {}, { values: {}, secrets: { cookie: "fixture" } }, true),
    ).not.toThrow();
  });

  it("explicitly resets ordinary fields without confusing zero or false with absence", () => {
    expect(
      mergePluginConfig(
        parsePluginManifest(manifest),
        { limit: 12, enabled: true, language: "zh" },
        { values: { limit: null, enabled: false, language: null } },
      ),
    ).toEqual({ limit: 5, enabled: false });
    const parsed = parsePluginManifest({
      ...manifest,
      config: [{ key: "count", label: "Count", type: "number", default: 7 }],
    });
    expect(mergePluginConfig(parsed, {}, { values: { count: 0 } })).toEqual({ count: 0 });
  });

  it.each([
    "toString",
    "valueOf",
    "hasOwnProperty",
    "isPrototypeOf",
    "propertyIsEnumerable",
    "toLocaleString",
  ])("rejects object property name %s before configuration reaches storage or UI", (key) => {
    expect(() =>
      parsePluginManifest({
        ...manifest,
        config: [{ key, label: "Format", type: "string", secret: true }],
      }),
    ).toThrow("Invalid or duplicate plugin configuration field");
  });
});
