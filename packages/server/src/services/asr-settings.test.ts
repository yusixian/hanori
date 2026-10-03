import type { Database } from "@cos-tool-bot/database";
import { describe, expect, it, vi } from "vitest";
import { decrypt } from "../utils/crypto.js";
import { AsrSettingsService } from "./asr-settings.js";

const KEY = "synthetic-asr-encryption-key";
function fixture() {
  let value: string | undefined;
  const store = vi.fn(({ value: next }: { value: string }) => ({
    onConflictDoUpdate: async () => {
      value = next;
    },
  }));
  const db = {
    select: () => ({
      from: () => ({ where: () => ({ limit: async () => (value ? [{ value }] : []) }) }),
    }),
    insert: () => ({ values: store }),
    execute: vi.fn(),
    transaction: async (operation: (tx: unknown) => Promise<unknown>) => operation(db),
  };
  return {
    service: new AsrSettingsService(db as unknown as Database, KEY),
    store,
    stored: () => value,
    corrupt: () => {
      value = '{"revision":1,"accounts":[]}';
    },
    db: db as unknown as Database,
  };
}

describe("shared ASR accounts", () => {
  it("defaults to the standard Tencent engine with no enabled credentials or assumed price", async () => {
    const { service } = fixture();
    const view = await service.getPublic();
    expect(view.revision).toBe(0);
    expect(view.accounts.map((account) => account.provider)).toEqual([
      "tencent",
      "aliyun",
      "groq",
      "openai",
    ]);
    expect(view.accounts[0]).toMatchObject({
      model: "16k_zh",
      enabled: false,
      configuredSecrets: [],
      costPerMinute: 0,
      currency: "CNY",
      maxPerJobCost: 1,
      dailyCost: 3,
      monthlyCost: 10,
    });
    expect(view.accounts[2]).toMatchObject({ freeOnly: false });
    expect(await service.runtime()).toBeNull();
  });
  it("encrypts credentials, omits them from every public response, and preserves blank updates", async () => {
    const { service, stored } = fixture();
    const first = await service.update({
      revision: 0,
      accounts: [
        {
          provider: "tencent",
          enabled: true,
          costPerMinute: 0.03,
          secrets: { secretId: "SyntheticTencentId", secretKey: "synthetic-secret-key" },
        },
      ],
    });
    expect(first.accounts[0]?.configuredSecrets).toEqual(["secretId", "secretKey"]);
    expect(JSON.stringify(first)).not.toContain("SyntheticTencentId");
    expect(JSON.stringify(await service.getPublic())).not.toContain("synthetic-secret-key");
    expect(stored()).not.toContain("synthetic-secret-key");
    const account = JSON.parse(stored()!).accounts[0];
    expect(decrypt(account.encryptedSecrets.secretKey, KEY)).toBe("synthetic-secret-key");
    const runtime = await service.runtime();
    expect(runtime).toMatchObject({
      providerAccount: "tencent",
      providerRevision: 1,
      currency: "CNY",
      freeAllowanceMinutes: 600,
      freeAllowancePeriod: "month",
      asr: {
        provider: "tencent",
        secretId: "SyntheticTencentId",
        secretKey: "synthetic-secret-key",
        model: "16k_zh",
      },
    });
    await service.update({
      revision: 1,
      accounts: [{ provider: "tencent", secrets: { secretId: "", secretKey: " " } }],
    });
    expect((await service.runtime())?.asr.secretKey).toBe("synthetic-secret-key");
    await service.update({
      revision: 2,
      accounts: [{ provider: "tencent", secrets: { secretKey: null } }],
    });
    expect(await service.runtime()).toBeNull();
  });
  it("rejects stale revisions without changing saved credentials", async () => {
    const { service, store } = fixture();
    await service.update({ revision: 0, accounts: [{ provider: "groq" }] });
    await expect(
      service.update({
        revision: 0,
        accounts: [{ provider: "groq", secrets: { apiKey: "new-secret" } }],
      }),
    ).rejects.toMatchObject({ code: "conflict" });
    expect(store).toHaveBeenCalledTimes(1);
  });
  it("skips unknown-priced accounts and requires explicit Groq free-plan confirmation for a zero rate", async () => {
    const { service } = fixture();
    await service.update({
      revision: 0,
      accounts: [
        {
          provider: "tencent",
          enabled: true,
          secrets: { secretId: "SyntheticId", secretKey: "synthetic-key" },
        },
        { provider: "groq", enabled: true, secrets: { apiKey: "synthetic-groq-key" } },
      ],
    });
    expect(await service.runtime()).toBeNull();
    await service.update({ revision: 1, accounts: [{ provider: "groq", freeOnly: true }] });
    expect(await service.runtime()).toMatchObject({
      providerAccount: "groq",
      limits: { costPerMinute: 0 },
      freeAllowanceMinutes: 480,
      freeAllowancePeriod: "day",
    });
    expect(await service.runtime("tencent")).toBeNull();
    expect((await service.runtime())?.freeQuota).toContain("账号计划未自动核实");
  });
  it("uses fixed priority and never substitutes a provider explicitly requested by an existing job", async () => {
    const { service } = fixture();
    await service.update({
      revision: 0,
      accounts: [
        {
          provider: "aliyun",
          enabled: true,
          costPerMinute: 0.005,
          secrets: { apiKey: "synthetic-ali-key" },
        },
        {
          provider: "groq",
          enabled: true,
          freeOnly: true,
          secrets: { apiKey: "synthetic-groq-key" },
        },
      ],
    });
    expect((await service.runtime())?.providerAccount).toBe("aliyun");
    expect((await service.runtime("groq"))?.providerAccount).toBe("groq");
    expect(await service.runtime("openai")).toBeNull();
  });
  it("expires manual quota verification and reports unknown balance without subtracting advertised allowance", async () => {
    const { service } = fixture();
    await service.update({
      revision: 0,
      accounts: [
        {
          provider: "aliyun",
          enabled: true,
          costPerMinute: 0.005,
          freeQuotaVerified: true,
          freeQuotaExpiresAt: "2001-01-01T00:00:00Z",
          secrets: { apiKey: "synthetic-key" },
        },
      ],
    });
    expect(await service.runtime()).toMatchObject({
      freeQuotaVerified: false,
      limits: { costPerMinute: 0.005 },
    });
    expect((await service.runtime())?.freeQuota).toContain("账户剩余免费额度未知");
    await service.update({
      revision: 1,
      accounts: [{ provider: "aliyun", freeQuotaExpiresAt: "2099-01-01T00:00:00Z" }],
    });
    expect((await service.runtime())?.freeQuota).toContain("管理员已核实");
    expect((await service.runtime())?.freeQuota).toContain("预估费用未抵扣免费额度");
  });
  it.each([
    { provider: "tencent", freeOnly: true },
    { provider: "aliyun", model: "unsupported-model" },
    { provider: "groq", baseUrl: "https://different.example/v1" },
    { provider: "openai", baseUrl: "https://provider.example/v1?key=secret" },
    { provider: "tencent", monthlyMinutes: 1.5 },
    { provider: "openai", costPerMinute: Infinity },
    { provider: "tencent", secrets: { secretKey: "secret\r\nInjected: true" } },
  ])("rejects invalid settings before saving or making a provider request: %j", async (account) => {
    const { service, store } = fixture();
    await expect(
      service.update({ revision: 0, accounts: [account] } as Parameters<typeof service.update>[0]),
    ).rejects.toMatchObject({ code: "invalid_configuration" });
    expect(store).not.toHaveBeenCalled();
  });
  it("fails closed on corrupt storage and incompatible encryption keys", async () => {
    const { service, db, corrupt } = fixture();
    await service.update({
      revision: 0,
      accounts: [
        { provider: "groq", enabled: true, freeOnly: true, secrets: { apiKey: "synthetic-key" } },
      ],
    });
    await expect(new AsrSettingsService(db, "wrong-key").runtime()).rejects.toMatchObject({
      code: "unreadable_configuration",
    });
    corrupt();
    await expect(service.getPublic()).rejects.toMatchObject({ code: "unreadable_configuration" });
    await expect(service.runtime()).rejects.toMatchObject({ code: "unreadable_configuration" });
  });
});
