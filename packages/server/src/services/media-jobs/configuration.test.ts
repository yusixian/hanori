import { randomUUID } from "node:crypto";
import type { Database } from "@cos-tool-bot/database";
import { publicPluginConfig, type PluginConfiguration } from "@cos-tool-bot/shared";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createBuiltinMediaPlugins } from "../plugins/builtin-media.js";
import type { PluginManager } from "../plugins/manager.js";
import { ASR_CONFIG_FIELDS, loadMediaJobConfiguration } from "./configuration.js";
import { MediaJobService } from "./service.js";

const BOT = randomUUID();
const sourceUrl = "https://www.bilibili.com/video/BV1xx411c7mD";
const runtimeConfiguration = vi.fn<PluginManager["runtimeConfiguration"]>();
const manager = { runtimeConfiguration } as unknown as PluginManager;
const defaults = Object.fromEntries(
  ASR_CONFIG_FIELDS.filter((field) => field.default !== undefined).map((field) => [
    field.key,
    field.default!,
  ]),
);
function enabled(overrides: PluginConfiguration = {}): PluginConfiguration {
  return {
    ...defaults,
    asrEnabled: true,
    asrTransferApproved: true,
    cookie: "SESSDATA=synthetic-cookie",
    asrApiKey: "synthetic-provider-secret",
    asrCostPerMinute: 0.01,
    ...overrides,
  };
}
function state(configuration: PluginConfiguration) {
  return { revision: 7, installationRevision: 11, configuration };
}

beforeEach(() => {
  runtimeConfiguration.mockReset();
});

describe("optional audio ASR configuration", () => {
  it("defaults to no ASR and no audio transfer or transcript export approval", async () => {
    expect(defaults).toMatchObject({
      asrEnabled: false,
      asrTransferApproved: false,
      asrAllowExport: false,
      asrCostPerMinute: 0,
    });
    runtimeConfiguration.mockResolvedValue(state(defaults));
    expect(await loadMediaJobConfiguration(manager, BOT)).toBeNull();
    expect(runtimeConfiguration).toHaveBeenCalledWith("hanori.bilibili", BOT);
  });

  it("requires the manager's active reviewed per-Bot runtime configuration", async () => {
    runtimeConfiguration.mockResolvedValue(null);
    expect(await loadMediaJobConfiguration(manager, BOT)).toBeNull();
    runtimeConfiguration.mockRejectedValue(new Error("manifest_changed"));
    await expect(loadMediaJobConfiguration(manager, BOT)).rejects.toThrow("manifest_changed");
  });

  it.each<PluginConfiguration>([
    { asrEnabled: false },
    { asrTransferApproved: false },
    { cookie: "" },
    { cookie: "   " },
    { asrApiKey: "" },
    { asrApiKey: "   " },
  ])("requires explicit enablement, transfer consent and credentials: %j", async (override) => {
    runtimeConfiguration.mockResolvedValue(state(enabled(override)));
    expect(await loadMediaJobConfiguration(manager, BOT)).toBeNull();
  });

  it("loads only the selected provider, limits and exact configuration revisions", async () => {
    runtimeConfiguration.mockResolvedValue(
      state(enabled({ asrLanguage: " en ", asrAllowExport: true })),
    );
    expect(await loadMediaJobConfiguration(manager, BOT)).toEqual({
      revision: 7,
      installationRevision: 11,
      cookie: "SESSDATA=synthetic-cookie",
      asr: {
        baseUrl: "https://api.openai.com/v1",
        apiKey: "synthetic-provider-secret",
        model: "whisper-1",
        language: "en",
      },
      limits: {
        maxDurationSeconds: 300,
        dailyJobs: 3,
        dailyMinutes: 10,
        costPerMinute: 0.01,
        maxDailyCost: 1,
      },
      allowExport: true,
    });
  });

  it("omits blank optional language and keeps export separately opt-in", async () => {
    runtimeConfiguration.mockResolvedValue(state(enabled({ asrLanguage: " " })));
    const config = await loadMediaJobConfiguration(manager, BOT);
    expect(config?.asr).not.toHaveProperty("language");
    expect(config?.allowExport).toBe(false);
  });

  it.each<PluginConfiguration>([
    { asrBaseUrl: "http://private.invalid/v1" },
    { asrBaseUrl: "https://provider.example/v1?key=private" },
    { asrApiKey: "synthetic-secret\r\nInjected: true" },
    { asrModel: "" },
    { asrLanguage: "invalid language" },
  ])("rejects an invalid provider configuration before any request: %j", async (override) => {
    runtimeConfiguration.mockResolvedValue(state(enabled(override)));
    await expect(loadMediaJobConfiguration(manager, BOT)).rejects.toMatchObject({
      code: "invalid_configuration",
    });
  });

  it("marks the API key secret and removes both credentials from management serialization", () => {
    const manifest = createBuiltinMediaPlugins().find(
      (entry) => entry.manifest.id === "hanori.bilibili",
    )!.manifest;
    expect(ASR_CONFIG_FIELDS.find((field) => field.key === "asrApiKey")).toMatchObject({
      secret: true,
    });
    expect(ASR_CONFIG_FIELDS.find((field) => field.key === "asrApiKey")).not.toHaveProperty(
      "default",
    );
    const visible = publicPluginConfig(manifest, enabled());
    expect(visible.configuredSecrets).toEqual(expect.arrayContaining(["cookie", "asrApiKey"]));
    expect(visible.values).not.toHaveProperty("cookie");
    expect(visible.values).not.toHaveProperty("asrApiKey");
    expect(JSON.stringify(visible)).not.toContain("synthetic-cookie");
    expect(JSON.stringify(visible)).not.toContain("synthetic-provider-secret");
  });

  it.each<PluginConfiguration>([
    { asrCostPerMinute: 0 },
    { asrCostPerMinute: -1 },
    { asrDailyCost: 0 },
  ])(
    "prevents job creation until a positive provider price and budget are configured: %j",
    async (override) => {
      runtimeConfiguration.mockResolvedValue(state(enabled(override)));
      const inspect = vi.fn();
      const select = vi.fn(() => {
        throw new Error("Unexpected database access");
      });
      const service = new MediaJobService({ select } as unknown as Database, {
        configuration: (botId) => loadMediaJobConfiguration(manager, botId),
        inspect,
        execute: vi.fn(),
      });
      await expect(
        service.create({ botId: BOT, chatId: 123, userId: 456, isAdmin: true }, { sourceUrl }),
      ).rejects.toMatchObject({ code: "configuration_required" });
      expect(inspect).not.toHaveBeenCalled();
      expect(select).not.toHaveBeenCalled();
      await service.close();
    },
  );
});
