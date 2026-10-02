import type { PluginConfigField } from "@cos-tool-bot/shared";
import type { PluginManager } from "../plugins/manager.js";
import type { MediaJobConfiguration } from "./contracts.js";
import { createAsrClient } from "../media/asr.js";

/** Optional ASR stays disabled until the owner supplies one provider and approves audio transfer. */
export const ASR_CONFIG_FIELDS: PluginConfigField[] = [
  {
    key: "asrEnabled",
    label: "启用音频转录 / Enable audio transcription",
    type: "boolean",
    default: false,
  },
  {
    key: "asrTransferApproved",
    label: "允许向所选 ASR 服务发送音频 / Allow audio transfer",
    description:
      "Only enable for content you are authorized to process. Audio is sent to the configured provider; no fallback provider is used.",
    type: "boolean",
    default: false,
  },
  {
    key: "asrBaseUrl",
    label: "ASR API URL",
    type: "string",
    default: "https://api.openai.com/v1",
    max: 2048,
  },
  { key: "asrApiKey", label: "ASR API Key", type: "string", secret: true, max: 4096 },
  { key: "asrModel", label: "ASR Model", type: "string", default: "whisper-1", max: 64 },
  {
    key: "asrLanguage",
    label: "语言代码（可选） / Language code (optional)",
    type: "string",
    max: 16,
  },
  {
    key: "asrMaxSeconds",
    label: "单视频秒数上限 / Maximum seconds per video",
    type: "integer",
    default: 300,
    min: 1,
    max: 600,
  },
  {
    key: "asrDailyJobs",
    label: "每用户每日任务上限 / Daily jobs per user",
    type: "integer",
    default: 3,
    min: 1,
    max: 10,
  },
  {
    key: "asrDailyMinutes",
    label: "每用户每日分钟上限 / Daily minutes per user",
    type: "integer",
    default: 10,
    min: 1,
    max: 60,
  },
  {
    key: "asrCostPerMinute",
    label: "配置供应商每分钟单价 / Provider price per minute",
    description:
      "Use your provider's current USD rate. Required to run ASR. Estimates reserve the full video duration; actual invoices may differ.",
    type: "number",
    default: 0,
    min: 0,
    max: 100,
  },
  {
    key: "asrDailyCost",
    label: "每用户每日预估费用上限（USD） / Daily estimated cost per user",
    type: "number",
    default: 1,
    min: 0.01,
    max: 100,
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
): Promise<MediaJobConfiguration | null> {
  const state = await manager.runtimeConfiguration("hanori.bilibili", botId);
  if (
    !state ||
    state.configuration.asrEnabled !== true ||
    state.configuration.asrTransferApproved !== true
  )
    return null;
  const value = state.configuration;
  if (
    typeof value.cookie !== "string" ||
    !value.cookie.trim() ||
    typeof value.asrApiKey !== "string" ||
    !value.asrApiKey.trim() ||
    typeof value.asrBaseUrl !== "string" ||
    typeof value.asrModel !== "string"
  )
    return null;
  const configuration: MediaJobConfiguration = {
    revision: state.revision,
    installationRevision: state.installationRevision,
    cookie: value.cookie,
    asr: {
      baseUrl: value.asrBaseUrl,
      apiKey: value.asrApiKey,
      model: value.asrModel,
      ...(typeof value.asrLanguage === "string" && value.asrLanguage.trim()
        ? { language: value.asrLanguage.trim() }
        : {}),
    },
    limits: {
      maxDurationSeconds: Number(value.asrMaxSeconds),
      dailyJobs: Number(value.asrDailyJobs),
      dailyMinutes: Number(value.asrDailyMinutes),
      costPerMinute: Number(value.asrCostPerMinute),
      maxDailyCost: Number(value.asrDailyCost),
    },
    allowExport: value.asrAllowExport === true,
  };
  createAsrClient(configuration.asr);
  return configuration;
}
