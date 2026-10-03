import { randomUUID } from "node:crypto";
import type { Database } from "@cos-tool-bot/database";
import { mergePluginConfig, type PluginConfiguration } from "@cos-tool-bot/shared";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createBuiltinMediaPlugins } from "../plugins/builtin-media.js";
import type { PluginManager } from "../plugins/manager.js";
import type { AsrRuntimeSettings } from "../asr-settings.js";
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
    asrBaseUrl: "https://api.openai.com/v1",
    asrModel: "whisper-1",
    asrApiKey: "synthetic-provider-secret",
    asrCostPerMinute: 0.01,
    ...overrides,
  };
}
function state(configuration: PluginConfiguration) {
  return { revision: 7, installationRevision: 11, configuration };
}

async function jobFixture(
  overrides: PluginConfiguration = {},
  durationSeconds = 900,
  usage = { count: 0, seconds: 0, cost: 0 },
) {
  runtimeConfiguration.mockResolvedValue(
    state(
      enabled({
        asrMaxSeconds: 1200,
        asrDailyJobs: 12,
        asrDailyMinutes: 120,
        asrCostPerMinute: 101,
        asrDailyCost: 2000,
        ...overrides,
      }),
    ),
  );
  const values = vi.fn((row: Record<string, unknown>) => ({
    returning: async () => [
      {
        ...row,
        id: randomUUID(),
        status: "pending_confirmation",
        progress: 0,
        error: null,
        result: null,
        notification: "pending",
      },
    ],
  }));
  const select = vi
    .fn()
    .mockReturnValueOnce({ from: () => ({ where: () => ({ limit: async () => [] }) }) })
    .mockReturnValueOnce({ from: () => ({ where: async () => [usage] }) });
  const transaction = vi.fn(async (run: (tx: unknown) => Promise<unknown>) =>
    run({
      execute: vi.fn(),
      select,
      insert: () => ({ values }),
    }),
  );
  const inspect = vi.fn(async () => ({
    canonicalUrl: sourceUrl,
    bvid: "BV1xx411c7mD",
    part: 1,
    title: "Synthetic video",
    durationSeconds,
    hasSubtitles: false,
  }));
  const execute = vi.fn();
  const service = new MediaJobService({ transaction } as unknown as Database, {
    configuration: (botId) => loadMediaJobConfiguration(manager, botId),
    inspect,
    execute,
    requestConfirmation: async () => {},
  });
  const create = () =>
    service.create({ botId: BOT, chatId: 123, userId: 456, isAdmin: true }, { sourceUrl });
  return { service, create, transaction, values, inspect, execute };
}

beforeEach(() => {
  runtimeConfiguration.mockReset();
});

describe("optional audio ASR configuration", () => {
  it("accepts owner-selected limits above the former GUI caps without changing defaults", async () => {
    const manifest = createBuiltinMediaPlugins().find(
      (entry) => entry.manifest.id === "hanori.bilibili",
    )!.manifest;
    const limits = {
      asrMaxSeconds: 1200,
      asrDailyJobs: 12,
      asrDailyMinutes: 120,
      asrDailyCost: 2000,
    };
    expect(mergePluginConfig(manifest, enabled(), { values: limits })).toMatchObject(limits);
    for (const key of Object.keys(limits))
      expect(ASR_CONFIG_FIELDS.find((field) => field.key === key)).not.toHaveProperty("max");
    expect(defaults).toMatchObject({
      asrMaxSeconds: 300,
      asrDailyJobs: 3,
      asrDailyMinutes: 10,
      asrDailyCost: 1,
    });
    expect(ASR_CONFIG_FIELDS.find((field) => field.key === "asrApiKey")).toBeUndefined();
    const fixture = await jobFixture();
    try {
      await expect(fixture.create()).resolves.toMatchObject({
        status: "pending_confirmation",
        durationSeconds: 900,
      });
      expect(fixture.values).toHaveBeenCalledWith(expect.objectContaining({ estimatedCost: 1515 }));
      expect(fixture.execute).not.toHaveBeenCalled();
    } finally {
      await fixture.service.close();
    }
  });

  it("rejects duration above the owner's limit before queuing or executing", async () => {
    const fixture = await jobFixture({}, 1201);
    try {
      await expect(fixture.create()).rejects.toMatchObject({ code: "duration_limit" });
      expect(fixture.transaction).not.toHaveBeenCalled();
      expect(fixture.execute).not.toHaveBeenCalled();
    } finally {
      await fixture.service.close();
    }
  });

  it("rejects a source duration that cannot be stored even with a larger configured limit", async () => {
    const fixture = await jobFixture({ asrMaxSeconds: Number.MAX_SAFE_INTEGER }, 2_147_483_648);
    try {
      await expect(fixture.create()).rejects.toMatchObject({ code: "duration_limit" });
      expect(fixture.transaction).not.toHaveBeenCalled();
    } finally {
      await fixture.service.close();
    }
  });

  it.each([
    { count: 12, seconds: 0, cost: 0 },
    { count: 0, seconds: 7200, cost: 0 },
    { count: 0, seconds: 0, cost: 1500 },
    { count: NaN, seconds: 0, cost: 0 },
    { count: 0, seconds: Number.MAX_SAFE_INTEGER + 1, cost: 0 },
    { count: 0, seconds: 0, cost: Infinity },
  ])("retains configured quotas and rejects unsafe stored usage: %j", async (usage) => {
    const fixture = await jobFixture({}, 900, usage);
    try {
      await expect(fixture.create()).rejects.toMatchObject({ code: "quota_exceeded" });
      expect(fixture.values).not.toHaveBeenCalled();
      expect(fixture.execute).not.toHaveBeenCalled();
    } finally {
      await fixture.service.close();
    }
  });

  it("compares a large safe integer minute budget without Number multiplication overflow", async () => {
    const fixture = await jobFixture({ asrDailyMinutes: Number.MAX_SAFE_INTEGER });
    try {
      await expect(fixture.create()).resolves.toMatchObject({ status: "pending_confirmation" });
    } finally {
      await fixture.service.close();
    }
  });

  it.each<PluginConfiguration>([
    { asrMaxSeconds: 0 },
    { asrMaxSeconds: 1.5 },
    { asrMaxSeconds: Number.MAX_SAFE_INTEGER + 1 },
    { asrDailyJobs: 0 },
    { asrDailyJobs: 1.5 },
    { asrDailyJobs: Number.MAX_SAFE_INTEGER + 1 },
    { asrDailyMinutes: 0 },
    { asrDailyMinutes: 1.5 },
    { asrDailyMinutes: Number.MAX_SAFE_INTEGER + 1 },
    { asrDailyMinutes: Infinity },
    { asrDailyCost: Infinity },
    { asrCostPerMinute: NaN },
  ])("rejects illegal numeric limits before inspecting media: %j", async (override) => {
    const fixture = await jobFixture(override);
    try {
      await expect(fixture.create()).rejects.toMatchObject({ code: "configuration_required" });
      expect(fixture.inspect).not.toHaveBeenCalled();
      expect(fixture.transaction).not.toHaveBeenCalled();
    } finally {
      await fixture.service.close();
    }
  });

  it.each([
    { price: Number.MAX_VALUE, duration: 1200 },
    { price: 1e8, duration: 60 },
    { price: Number.MIN_VALUE, duration: 1 },
    { price: 1e-13, duration: 60 },
  ])(
    "rejects a fee reservation that cannot be safely persisted: %j",
    async ({ price, duration }) => {
      const fixture = await jobFixture(
        { asrCostPerMinute: price, asrDailyCost: Number.MAX_VALUE },
        duration,
      );
      try {
        await expect(fixture.create()).rejects.toMatchObject({ code: "configuration_required" });
        expect(fixture.transaction).not.toHaveBeenCalled();
        expect(fixture.execute).not.toHaveBeenCalled();
      } finally {
        await fixture.service.close();
      }
    },
  );

  it("still rejects fees above a configured budget", async () => {
    const fixture = await jobFixture({ asrCostPerMinute: 0.011, asrDailyCost: 0.01 }, 60);
    try {
      await expect(fixture.create()).rejects.toMatchObject({ code: "quota_exceeded" });
      expect(fixture.values).not.toHaveBeenCalled();
    } finally {
      await fixture.service.close();
    }
  });
  it("admits the sixth ten-second reservation after database decimal quantization", async () => {
    const fixture = await jobFixture({ asrCostPerMinute: 0.1, asrDailyCost: 0.1 }, 10, {
      count: 5,
      seconds: 50,
      cost: 0.083333333335,
    });
    try {
      await expect(fixture.create()).resolves.toMatchObject({ status: "pending_confirmation" });
    } finally {
      await fixture.service.close();
    }
  });

  it("rejects the seventh ten-second reservation after database decimal quantization", async () => {
    const fixture = await jobFixture({ asrCostPerMinute: 0.1, asrDailyCost: 0.1 }, 10, {
      count: 6,
      seconds: 60,
      cost: 0.100000000002,
    });
    try {
      await expect(fixture.create()).rejects.toMatchObject({ code: "quota_exceeded" });
      expect(fixture.values).not.toHaveBeenCalled();
    } finally {
      await fixture.service.close();
    }
  });

  it("defaults to no ASR and no audio transfer or transcript export approval", async () => {
    expect(defaults).toMatchObject({
      asrEnabled: false,
      asrTransferApproved: false,
      asrAllowExport: false,
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
    expect(await loadMediaJobConfiguration(manager, BOT)).toMatchObject({
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

  it("uses shared Tencent credentials with separate administrator, Bot and account budgets", async () => {
    runtimeConfiguration.mockResolvedValue(state(enabled()));
    const runtime = vi.fn(
      async (): Promise<AsrRuntimeSettings> => ({
        asr: {
          provider: "tencent",
          baseUrl: "https://asr.tencentcloudapi.com",
          apiKey: "",
          secretId: "SyntheticTencentId",
          secretKey: "synthetic-secret",
          region: "ap-shanghai",
          model: "16k_zh",
        },
        providerRevision: 4,
        providerAccount: "tencent",
        currency: "CNY",
        freeOnly: false,
        freeQuota: "账户剩余免费额度未知",
        freeQuotaVerified: false,
        freeQuotaExpiresAt: "",
        freeAllowanceMinutes: 600,
        freeAllowancePeriod: "month",
        limits: {
          costPerMinute: 0.03,
          maxPerJobCost: 1,
          dailyCost: 3,
          monthlyCost: 10,
          monthlyMinutes: 600,
        },
      }),
    );
    const configuration = await loadMediaJobConfiguration(manager, BOT, { runtime }, "tencent");
    expect(runtime).toHaveBeenCalledWith("tencent");
    expect(configuration).toMatchObject({
      providerRevision: 4,
      providerAccount: "tencent",
      currency: "CNY",
      asr: { provider: "tencent", model: "16k_zh" },
      limits: {
        costPerMinute: 0.03,
        maxPerJobCost: 1,
        maxDailyCost: 1,
        monthlyMinutes: 120,
        maxMonthlyCost: 10,
        botMonthlyMinutes: 600,
        botMaxMonthlyCost: 50,
        accountDailyCost: 3,
        accountMonthlyCost: 10,
        accountMonthlyMinutes: 600,
      },
    });
    expect(configuration?.asr.apiKey).toBe("");
    expect(configuration?.asr).not.toHaveProperty("language");
  });

  it("never falls back to legacy OpenAI when an existing task requests a different provider", async () => {
    runtimeConfiguration.mockResolvedValue(state(enabled()));
    const runtime = vi.fn(async () => null);
    expect(await loadMediaJobConfiguration(manager, BOT, { runtime }, "tencent")).toBeNull();
    expect(await loadMediaJobConfiguration(manager, BOT, { runtime }, "aliyun")).toBeNull();
    expect(await loadMediaJobConfiguration(manager, BOT, { runtime }, "groq")).toBeNull();
    expect(await loadMediaJobConfiguration(manager, BOT, { runtime }, "openai")).toBeNull();
    expect(await loadMediaJobConfiguration(manager, BOT, { runtime }, "legacy")).toMatchObject({
      providerAccount: "legacy",
      currency: "USD",
    });
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

  it("keeps shared provider credentials out of the per-Bot plugin configuration", () => {
    for (const key of [
      "asrApiKey",
      "asrBaseUrl",
      "asrModel",
      "asrCostPerMinute",
      "asrSecretId",
      "asrSecretKey",
    ])
      expect(ASR_CONFIG_FIELDS.some((field) => field.key === key)).toBe(false);
    expect(defaults).toMatchObject({ asrMonthlyMinutes: 120, asrBotMonthlyMinutes: 600 });
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
