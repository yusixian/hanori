import type { PluginConfiguration } from "@cos-tool-bot/shared";
import { mergePluginConfig } from "@cos-tool-bot/shared";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createBuiltinMediaPlugins } from "../plugins/builtin-media.js";
import type { PluginManager } from "../plugins/manager.js";
import { loadVideoDownloadConfiguration, VIDEO_DOWNLOAD_CONFIG_FIELDS } from "./configuration.js";

const runtimeConfiguration = vi.fn<PluginManager["runtimeConfiguration"]>();
const manager = { runtimeConfiguration } as unknown as PluginManager;
const defaults = Object.fromEntries(
  VIDEO_DOWNLOAD_CONFIG_FIELDS.filter(({ default: value }) => value !== undefined).map((field) => [
    field.key,
    field.default!,
  ]),
);
function enabled(overrides: PluginConfiguration = {}) {
  return { ...defaults, downloadEnabled: true, cookie: "SESSDATA=synthetic-cookie", ...overrides };
}
function state(configuration: PluginConfiguration) {
  return { revision: 7, installationRevision: 11, configuration };
}
async function load(overrides: PluginConfiguration = {}) {
  runtimeConfiguration.mockResolvedValue(state(enabled(overrides)));
  return loadVideoDownloadConfiguration(manager, "synthetic-bot");
}

beforeEach(() => {
  runtimeConfiguration.mockReset();
});

describe("optional video download configuration", () => {
  it("loads the general extractor configuration without requiring Bilibili credentials", async () => {
    runtimeConfiguration.mockResolvedValue(state({ ...defaults, downloadEnabled: true }));
    expect(await loadVideoDownloadConfiguration(manager, "synthetic-bot", "ytdlp")).toMatchObject({
      provider: "ytdlp",
      revision: 7,
      installationRevision: 11,
    });
    expect(runtimeConfiguration).toHaveBeenCalledWith("hanori.ytdlp", "synthetic-bot");
  });
  it("publishes opt-in defaults, bilingual labels and numeric fields without GUI upper caps", () => {
    expect(defaults).toEqual({
      downloadEnabled: false,
      downloadMaxSeconds: 600,
      downloadMaxMb: 45,
      downloadCacheMinutes: 30,
      downloadCacheMb: 512,
      downloadMinFreeMb: 1024,
      downloadDailyJobs: 5,
    });
    for (const field of VIDEO_DOWNLOAD_CONFIG_FIELDS) {
      expect(field.label).toContain(" / ");
      if (field.type === "integer") expect(field).not.toHaveProperty("max");
    }
    const manifest = createBuiltinMediaPlugins()[0]!.manifest;
    const limits = {
      downloadMaxSeconds: 3600,
      downloadMaxMb: 100,
      downloadCacheMinutes: 50_000,
      downloadCacheMb: 2048,
      downloadDailyJobs: 20,
    };
    expect(mergePluginConfig(manifest, enabled(), { values: limits })).toMatchObject(limits);
  });

  it("loads reviewed configuration revisions and independent download limits in decimal units", async () => {
    expect(await load({ asrEnabled: false, asrTransferApproved: false })).toEqual({
      revision: 7,
      installationRevision: 11,
      cookie: "SESSDATA=synthetic-cookie",
      limits: {
        maxDurationSeconds: 600,
        maxBytes: 45_000_000,
        cacheTtlMs: 1_800_000,
        maxCacheBytes: 512_000_000,
        minFreeDiskBytes: 1_024_000_000,
        dailyJobs: 5,
      },
    });
    expect(runtimeConfiguration).toHaveBeenCalledWith("hanori.bilibili", "synthetic-bot");
  });

  it("retains owner limits while clamping output size to Telegram's physical capacity", async () => {
    expect(
      (
        await load({
          downloadMaxSeconds: 3600,
          downloadMaxMb: 100,
          downloadCacheMinutes: 50_000,
          downloadDailyJobs: 20,
        })
      )?.limits,
    ).toMatchObject({
      maxDurationSeconds: 3600,
      maxBytes: 50_000_000,
      cacheTtlMs: 3_000_000_000,
      dailyJobs: 20,
    });
  });

  it("requires an active reviewed configuration", async () => {
    runtimeConfiguration.mockResolvedValue(null);
    expect(await loadVideoDownloadConfiguration(manager, "synthetic-bot")).toBeNull();
    runtimeConfiguration.mockRejectedValue(new Error("manifest_changed"));
    await expect(loadVideoDownloadConfiguration(manager, "synthetic-bot")).rejects.toThrow(
      "manifest_changed",
    );
  });

  it.each<PluginConfiguration>([
    { downloadEnabled: false },
    { cookie: "" },
    { cookie: "   " },
    { downloadMaxSeconds: 0 },
    { downloadMaxSeconds: 1.5 },
    { downloadMaxSeconds: "600" },
    { downloadDailyJobs: Number.MAX_SAFE_INTEGER + 1 },
    { downloadDailyJobs: Infinity },
    { downloadMaxMb: 0 },
    { downloadMaxMb: Number.MAX_SAFE_INTEGER },
    { downloadCacheMb: Number.MAX_SAFE_INTEGER },
    { downloadMinFreeMb: Number.MAX_SAFE_INTEGER },
    { downloadCacheMinutes: 0 },
    { downloadCacheMinutes: Number.MAX_SAFE_INTEGER },
    { downloadCacheMinutes: Math.floor(8_640_000_000_000_000 / 60_000) },
    { downloadMinFreeMb: -1 },
    { downloadMinFreeMb: NaN },
  ])("rejects disabled, missing credentials and unsafe effective limits: %j", async (override) => {
    expect(await load(override)).toBeNull();
  });

  it("allows zero reserved disk space but requires cache room for input plus merged output", async () => {
    expect(
      (await load({ downloadMinFreeMb: 0, downloadCacheMb: 92 }))?.limits.minFreeDiskBytes,
    ).toBe(0);
    await expect(load({ downloadCacheMb: 91 })).rejects.toMatchObject({
      code: "cache_budget_too_small",
    });
    await expect(load({ downloadMaxMb: 100, downloadCacheMb: 101 })).rejects.toMatchObject({
      code: "cache_budget_too_small",
    });
    expect((await load({ downloadMaxMb: 100, downloadCacheMb: 102 }))?.limits.maxCacheBytes).toBe(
      102_000_000,
    );
  });
});
