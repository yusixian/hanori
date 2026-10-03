export const ASR_PROVIDERS = ["tencent", "aliyun", "groq", "openai"] as const;
export type AsrProvider = (typeof ASR_PROVIDERS)[number];
export type AsrCurrency = "CNY" | "USD";
export type AsrSecretName = "apiKey" | "secretId" | "secretKey";

export interface AsrAccountSettings {
  provider: AsrProvider;
  enabled: boolean;
  baseUrl: string;
  model: string;
  region: string;
  currency: AsrCurrency;
  /** A zero rate is unknown except for explicitly selected Groq free-only usage. */
  costPerMinute: number;
  maxPerJobCost: number;
  dailyCost: number;
  monthlyCost: number;
  monthlyMinutes: number;
  freeOnly: boolean;
  freeQuotaVerified: boolean;
  freeQuotaExpiresAt: string;
  policyCheckedAt: string;
}

export interface AsrAccountPublic extends AsrAccountSettings {
  configuredSecrets: AsrSecretName[];
}
export interface AsrSettingsPublic {
  revision: number;
  accounts: AsrAccountPublic[];
}
export type AsrAccountUpdate = Partial<Omit<AsrAccountSettings, "provider" | "currency">> & {
  provider: AsrProvider;
  /** Omitted or blank values preserve an existing secret; null explicitly clears it. */
  secrets?: Partial<Record<AsrSecretName, string | null>>;
};
export interface AsrSettingsUpdate {
  revision: number;
  accounts: AsrAccountUpdate[];
}

export function defaultAsrAccounts(): AsrAccountSettings[] {
  return ASR_PROVIDERS.map((provider) => {
    const isCny = provider === "tencent" || provider === "aliyun";
    return {
      provider,
      enabled: false,
      baseUrl:
        provider === "tencent"
          ? "https://asr.tencentcloudapi.com"
          : provider === "aliyun"
            ? "https://dashscope.aliyuncs.com/api/v1"
            : provider === "groq"
              ? "https://api.groq.com/openai/v1"
              : "https://api.openai.com/v1",
      model:
        provider === "tencent"
          ? "16k_zh"
          : provider === "aliyun"
            ? "paraformer-v2"
            : provider === "groq"
              ? "whisper-large-v3-turbo"
              : "whisper-1",
      region: provider === "tencent" ? "ap-shanghai" : "",
      currency: isCny ? "CNY" : "USD",
      costPerMinute: 0,
      maxPerJobCost: isCny ? 1 : 0.2,
      dailyCost: isCny ? 3 : 0.6,
      monthlyCost: isCny ? 10 : 2,
      monthlyMinutes: 600,
      freeOnly: false,
      freeQuotaVerified: false,
      freeQuotaExpiresAt: "",
      policyCheckedAt: "",
    };
  });
}
