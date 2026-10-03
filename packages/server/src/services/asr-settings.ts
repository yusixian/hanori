import { settings, type Database } from "@cos-tool-bot/database";
import {
  ASR_PROVIDERS,
  defaultAsrAccounts,
  type AsrAccountPublic,
  type AsrAccountSettings,
  type AsrProvider,
  type AsrSecretName,
  type AsrSettingsPublic,
  type AsrSettingsUpdate,
} from "@cos-tool-bot/shared";
import { eq, sql } from "drizzle-orm";
import { z } from "zod";
import { encrypt, tryDecrypt } from "../utils/crypto.js";
import { createMediaAsrClient } from "./media/asr-providers.js";

const SETTING_KEY = "asr_accounts";
const SECRET_NAMES: AsrSecretName[] = ["apiKey", "secretId", "secretKey"];
const money = z.number().finite().min(0).max(1_000_000);
const date = z
  .string()
  .max(40)
  .refine((value) => !value || Number.isFinite(Date.parse(value)));
const secret = z
  .string()
  .max(4096)
  .refine((value) => !value.trim() || /^[!-~]+$/.test(value.trim()));
const accountUpdate = z
  .object({
    provider: z.enum(ASR_PROVIDERS),
    enabled: z.boolean().optional(),
    baseUrl: z.string().max(2048).optional(),
    model: z
      .string()
      .trim()
      .min(1)
      .max(64)
      .regex(/^[A-Za-z0-9_.-]+$/)
      .optional(),
    region: z
      .string()
      .max(64)
      .regex(/^[A-Za-z0-9-]*$/)
      .optional(),
    costPerMinute: money.optional(),
    maxPerJobCost: money.positive().optional(),
    dailyCost: money.positive().optional(),
    monthlyCost: money.positive().optional(),
    monthlyMinutes: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).optional(),
    freeOnly: z.boolean().optional(),
    freeQuotaVerified: z.boolean().optional(),
    freeQuotaExpiresAt: date.optional(),
    policyCheckedAt: date.optional(),
    secrets: z
      .object({
        apiKey: secret.nullable().optional(),
        secretId: secret.nullable().optional(),
        secretKey: secret.nullable().optional(),
      })
      .strict()
      .optional(),
  })
  .strict();
export const asrSettingsUpdateSchema = z
  .object({
    revision: z
      .number()
      .int()
      .min(0)
      .max(Number.MAX_SAFE_INTEGER - 1),
    accounts: z
      .array(accountUpdate)
      .min(1)
      .max(4)
      .refine(
        (accounts) => new Set(accounts.map((account) => account.provider)).size === accounts.length,
      ),
  })
  .strict();
const storedAccountSchema = accountUpdate.omit({ secrets: true }).required();

interface StoredAccount extends AsrAccountSettings {
  encryptedSecrets: Partial<Record<AsrSecretName, string>>;
}
interface StoredSettings {
  revision: number;
  accounts: StoredAccount[];
}
export interface AsrRuntimeSettings {
  asr: {
    provider: AsrProvider;
    baseUrl: string;
    apiKey: string;
    model: string;
    region: string;
    secretId?: string;
    secretKey?: string;
  };
  providerRevision: number;
  providerAccount: string;
  currency: "CNY" | "USD";
  freeQuota: string;
  freeOnly: boolean;
  freeQuotaVerified: boolean;
  freeQuotaExpiresAt: string;
  /** Published policy allowance, never an assertion of this account's available balance. */
  freeAllowanceMinutes: number;
  freeAllowancePeriod: "month" | "day" | "none";
  limits: {
    costPerMinute: number;
    maxPerJobCost: number;
    dailyCost: number;
    monthlyCost: number;
    monthlyMinutes: number;
  };
}
export class AsrSettingsError extends Error {
  constructor(readonly code: "conflict" | "invalid_configuration" | "unreadable_configuration") {
    super(`ASR settings: ${code}`);
  }
}

function initial(): StoredSettings {
  return {
    revision: 0,
    accounts: defaultAsrAccounts().map((account) => ({ ...account, encryptedSecrets: {} })),
  };
}
function publicSettings(stored: StoredSettings): AsrSettingsPublic {
  return {
    revision: stored.revision,
    accounts: stored.accounts.map(
      ({ encryptedSecrets, ...account }): AsrAccountPublic => ({
        ...account,
        configuredSecrets: SECRET_NAMES.filter((name) => !!encryptedSecrets[name]),
      }),
    ),
  };
}
function quotaDescription(account: AsrAccountSettings): string {
  const verified =
    account.freeQuotaVerified &&
    Number.isFinite(Date.parse(account.freeQuotaExpiresAt)) &&
    Date.parse(account.freeQuotaExpiresAt) > Date.now();
  const balance = verified
    ? `管理员已核实账户免费额度，有效期至 ${account.freeQuotaExpiresAt}`
    : "账户剩余免费额度未知";
  const policy =
    account.provider === "tencent"
      ? account.model === "16k_zh"
        ? "腾讯云常规录音文件识别官方每月 10 小时；大模型不适用该额度"
        : "所选腾讯云引擎免费规则需单独核实"
      : account.provider === "aliyun"
        ? "阿里云百炼北京地域 Paraformer 官方每月 10 小时，有效期 1 个月"
        : account.provider === "groq" && account.freeOnly
          ? "管理员确认此密钥属于 Groq 免费计划；账号计划未自动核实，付费计划不得使用零单价"
          : "所选服务免费规则需核实";
  return `${policy}；${balance}；预估费用未抵扣免费额度`;
}

/** One account per provider, shared by all Bots; plaintext secrets never enter public views. */
export class AsrSettingsService {
  constructor(
    private readonly db: Database,
    private readonly encryptionKey: string,
  ) {}

  private decode(value?: string): StoredSettings {
    if (!value) return initial();
    try {
      const stored = JSON.parse(value) as StoredSettings;
      if (
        !Number.isSafeInteger(stored.revision) ||
        stored.revision < 0 ||
        !Array.isArray(stored.accounts) ||
        stored.accounts.length !== ASR_PROVIDERS.length
      )
        throw new Error();
      const defaults = initial();
      for (const account of stored.accounts) {
        const { encryptedSecrets, currency, ...fields } = account;
        if (
          !storedAccountSchema.safeParse(fields).success ||
          currency !==
            defaults.accounts.find((item) => item.provider === account.provider)?.currency ||
          !encryptedSecrets ||
          typeof encryptedSecrets !== "object" ||
          Object.entries(encryptedSecrets).some(
            ([name, value]) =>
              !SECRET_NAMES.includes(name as AsrSecretName) || typeof value !== "string",
          )
        )
          throw new Error();
      }
      if (new Set(stored.accounts.map((account) => account.provider)).size !== ASR_PROVIDERS.length)
        throw new Error();
      return stored;
    } catch {
      throw new AsrSettingsError("unreadable_configuration");
    }
  }

  private async read(): Promise<StoredSettings> {
    const [row] = await this.db
      .select()
      .from(settings)
      .where(eq(settings.key, SETTING_KEY))
      .limit(1);
    return this.decode(row?.value);
  }
  async getPublic(): Promise<AsrSettingsPublic> {
    return publicSettings(await this.read());
  }
  async update(input: AsrSettingsUpdate): Promise<AsrSettingsPublic> {
    const parsed = asrSettingsUpdateSchema.safeParse(input);
    if (!parsed.success) throw new AsrSettingsError("invalid_configuration");
    return this.db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext('asr-accounts'))`);
      const [row] = await tx.select().from(settings).where(eq(settings.key, SETTING_KEY)).limit(1);
      const current = this.decode(row?.value);
      if (current.revision !== parsed.data.revision) throw new AsrSettingsError("conflict");
      const next: StoredSettings = {
        revision: current.revision + 1,
        accounts: current.accounts.map((existing) => {
          const update = parsed.data.accounts.find(
            (account) => account.provider === existing.provider,
          );
          if (!update) return existing;
          const { secrets, ...values } = update;
          const account: StoredAccount = {
            ...existing,
            ...values,
            encryptedSecrets: { ...existing.encryptedSecrets },
          };
          if (account.freeOnly && account.provider !== "groq")
            throw new AsrSettingsError("invalid_configuration");
          for (const name of SECRET_NAMES) {
            const value = secrets?.[name];
            if (value === null) delete account.encryptedSecrets[name];
            else if (value?.trim())
              account.encryptedSecrets[name] = encrypt(value.trim(), this.encryptionKey);
          }
          if (
            account.provider !== "openai" &&
            account.baseUrl !==
              defaultAsrAccounts().find((item) => item.provider === account.provider)?.baseUrl
          )
            throw new AsrSettingsError("invalid_configuration");
          const credentials: Record<AsrSecretName, string> = {
            apiKey: "validation",
            secretId: "validation",
            secretKey: "validation",
          };
          for (const name of SECRET_NAMES) {
            const encrypted = account.encryptedSecrets[name];
            if (!encrypted) continue;
            const decoded = tryDecrypt(encrypted, this.encryptionKey);
            if (!decoded) throw new AsrSettingsError("unreadable_configuration");
            credentials[name] = decoded;
          }
          // Constructing a client validates settings without sending any provider request.
          try {
            createMediaAsrClient({
              provider: account.provider,
              baseUrl: account.baseUrl,
              model: account.model,
              ...credentials,
              region: account.region,
            });
          } catch {
            throw new AsrSettingsError("invalid_configuration");
          }
          return account;
        }),
      };
      const value = JSON.stringify(next);
      await tx
        .insert(settings)
        .values({ key: SETTING_KEY, value })
        .onConflictDoUpdate({
          target: settings.key,
          set: { value, updatedAt: new Date() },
        });
      return publicSettings(next);
    });
  }
  async runtime(provider?: AsrProvider): Promise<AsrRuntimeSettings | null> {
    const stored = await this.read();
    for (const candidate of provider ? [provider] : ASR_PROVIDERS) {
      const account = stored.accounts.find((item) => item.provider === candidate);
      if (!account?.enabled) continue;
      const names: AsrSecretName[] =
        candidate === "tencent" ? ["secretId", "secretKey"] : ["apiKey"];
      if (names.some((name) => !account.encryptedSecrets[name])) continue;
      const secrets: Partial<Record<AsrSecretName, string>> = {};
      for (const name of names) {
        const decoded = tryDecrypt(account.encryptedSecrets[name]!, this.encryptionKey);
        if (!decoded) throw new AsrSettingsError("unreadable_configuration");
        secrets[name] = decoded;
      }
      if (!(account.costPerMinute > 0) && !(candidate === "groq" && account.freeOnly)) continue;
      return {
        asr: {
          provider: candidate,
          baseUrl: account.baseUrl,
          model: account.model,
          region: account.region,
          apiKey: secrets.apiKey ?? "",
          ...(secrets.secretId ? { secretId: secrets.secretId, secretKey: secrets.secretKey } : {}),
        },
        providerRevision: stored.revision,
        providerAccount: candidate,
        currency: account.currency,
        freeQuota: quotaDescription(account),
        freeOnly: account.freeOnly,
        freeQuotaVerified:
          account.freeQuotaVerified && Date.parse(account.freeQuotaExpiresAt) > Date.now(),
        freeQuotaExpiresAt: account.freeQuotaExpiresAt,
        freeAllowanceMinutes:
          (candidate === "tencent" && account.model === "16k_zh") || candidate === "aliyun"
            ? 600
            : candidate === "groq" && account.freeOnly
              ? 480
              : 0,
        freeAllowancePeriod:
          (candidate === "tencent" && account.model === "16k_zh") || candidate === "aliyun"
            ? "month"
            : candidate === "groq" && account.freeOnly
              ? "day"
              : "none",
        limits: {
          costPerMinute: account.freeOnly ? 0 : account.costPerMinute,
          maxPerJobCost: account.maxPerJobCost,
          dailyCost: account.dailyCost,
          monthlyCost: account.monthlyCost,
          monthlyMinutes: account.monthlyMinutes,
        },
      };
    }
    return null;
  }
}
