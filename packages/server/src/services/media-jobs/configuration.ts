import type { AsrProvider, PluginConfigField } from "@cos-tool-bot/shared";
import type { PluginManager } from "../plugins/manager.js";
import type { AsrSettingsService } from "../asr-settings.js";
import type { MediaJobConfiguration } from "./contracts.js";
import { createMediaAsrClient } from "../media/asr-providers.js";

/** Credentials belong to instance settings; each Bot separately opts into audio transfer. */
export const ASR_CONFIG_FIELDS: PluginConfigField[] = [
  {
    key: "asrEnabled",
    label: "启用音频转录 / Enable audio transcription",
    description:
      "供应商、密钥和单价在公共 ASR 设置管理；每次转录仍须管理员确认。 / Providers, credentials and prices are managed in shared ASR settings. Every task requires administrator confirmation.",
    type: "boolean",
    default: false,
  },
  {
    key: "asrTransferApproved",
    label: "允许向所选 ASR 服务发送音频 / Allow audio transfer",
    description:
      "Only enable for content you are authorized to process. The confirmation shows the selected provider; confirmed tasks never switch providers.",
    type: "boolean",
    default: false,
  },
  {
    key: "asrMaxSeconds",
    label: "单视频秒数上限 / Maximum seconds per video",
    description:
      "超过此时长会拒绝。腾讯云和百炼支持单段最长 5 小时；Groq / OpenAI 兼容上传仍限 20 MiB（约 10 分 55 秒）。 / Reject longer videos. Tencent/Alibaba URL transcription supports up to 5 hours; Groq/OpenAI-compatible uploads remain limited to 20 MiB (about 10m 55s).",
    type: "integer",
    default: 300,
    min: 1,
  },
  {
    key: "asrDailyJobs",
    label: "每管理员每日任务上限 / Daily jobs per administrator",
    type: "integer",
    default: 3,
    min: 1,
  },
  {
    key: "asrDailyMinutes",
    label: "每管理员每日分钟上限 / Daily minutes per administrator",
    type: "integer",
    default: 10,
    min: 1,
  },
  {
    key: "asrDailyCost",
    label: "每管理员每日预估费用上限 / Daily estimated cost per administrator",
    description:
      "采用所选供应商币种：腾讯云和百炼 CNY，Groq 和 OpenAI 兼容 USD；还受公共账户预算限制。 / Uses the selected provider currency: CNY for Tencent/Alibaba, USD for Groq/OpenAI. Shared account budgets also apply.",
    type: "number",
    default: 1,
    min: 0.01,
  },
  {
    key: "asrMonthlyMinutes",
    label: "每管理员每月分钟上限 / Monthly minutes per administrator",
    type: "integer",
    default: 120,
    min: 1,
  },
  {
    key: "asrMonthlyCost",
    label:
      "每管理员每月预估费用上限（供应商币种） / Monthly cost per administrator (provider currency)",
    type: "number",
    default: 10,
    min: 0.01,
  },
  {
    key: "asrBotMonthlyMinutes",
    label: "每 Bot 每月分钟上限 / Monthly minutes per Bot",
    type: "integer",
    default: 600,
    min: 1,
  },
  {
    key: "asrBotMonthlyCost",
    label: "每 Bot 每月预估费用上限（供应商币种） / Monthly cost per Bot (provider currency)",
    type: "number",
    default: 50,
    min: 0.01,
  },
  {
    key: "asrAllowExport",
    label: "允许有授权内容的全文导出 / Allow authorized transcript export",
    description:
      "Export still requires a separate rights confirmation for the individual job in the web panel. It does not authorize redistribution of copyrighted videos.",
    type: "boolean",
    default: false,
  },
];

export async function loadMediaJobConfiguration(
  manager: PluginManager,
  botId: string,
  asrSettings?: Pick<AsrSettingsService, "runtime">,
  provider?: AsrProvider | "legacy",
): Promise<MediaJobConfiguration | null> {
  const state = await manager.runtimeConfiguration("hanori.bilibili", botId);
  if (
    !state ||
    state.configuration.asrEnabled !== true ||
    state.configuration.asrTransferApproved !== true
  )
    return null;
  const value = state.configuration;
  if (typeof value.cookie !== "string" || !value.cookie.trim()) return null;
  const shared = provider === "legacy" ? undefined : await asrSettings?.runtime(provider);
  let asr: MediaJobConfiguration["asr"];
  if (shared) asr = shared.asr;
  else {
    // Retain already-saved OpenAI configurations during migration, never for a requested new provider.
    if (provider && provider !== "legacy") return null;
    if (
      typeof value.asrApiKey !== "string" ||
      !value.asrApiKey.trim() ||
      typeof value.asrBaseUrl !== "string" ||
      typeof value.asrModel !== "string"
    )
      return null;
    asr = {
      provider: "openai",
      baseUrl: value.asrBaseUrl,
      apiKey: value.asrApiKey,
      model: value.asrModel,
      ...(typeof value.asrLanguage === "string" && value.asrLanguage.trim()
        ? { language: value.asrLanguage.trim() }
        : {}),
    };
  }
  const configuration: MediaJobConfiguration = {
    revision: state.revision,
    installationRevision: state.installationRevision,
    cookie: value.cookie,
    asr,
    providerRevision: shared?.providerRevision ?? 1,
    providerAccount: shared?.providerAccount ?? "legacy",
    currency: shared?.currency ?? "USD",
    freeQuota: shared?.freeQuota ?? "旧版 OpenAI 配置；免费额度未知，预估费用未抵扣免费额度",
    freeAllowanceMinutes: shared?.freeAllowanceMinutes ?? 0,
    freeAllowancePeriod: shared?.freeAllowancePeriod ?? "none",
    limits: {
      maxDurationSeconds: Number(value.asrMaxSeconds),
      dailyJobs: Number(value.asrDailyJobs),
      dailyMinutes: Number(value.asrDailyMinutes),
      costPerMinute: shared?.limits.costPerMinute ?? Number(value.asrCostPerMinute),
      maxDailyCost: Number(value.asrDailyCost),
      ...(shared
        ? {
            maxPerJobCost: shared.limits.maxPerJobCost,
            monthlyMinutes: Number(value.asrMonthlyMinutes ?? 120),
            maxMonthlyCost: Number(value.asrMonthlyCost ?? 10),
            botMonthlyMinutes: Number(value.asrBotMonthlyMinutes ?? 600),
            botMaxMonthlyCost: Number(value.asrBotMonthlyCost ?? 50),
            accountDailyCost: shared.limits.dailyCost,
            accountMonthlyCost: shared.limits.monthlyCost,
            accountMonthlyMinutes: shared.limits.monthlyMinutes,
          }
        : {}),
    },
    allowExport: value.asrAllowExport === true,
  };
  createMediaAsrClient(configuration.asr);
  return configuration;
}
