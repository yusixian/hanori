import type { PluginConfigField } from "@cos-tool-bot/shared";
import type { PluginManager } from "../plugins/manager.js";
import {
  TELEGRAM_VIDEO_MAX_BYTES,
  VIDEO_DOWNLOAD_TEMP_OVERHEAD_BYTES,
  VideoDownloadError,
  type VideoDownloadConfiguration,
} from "./contracts.js";

export const VIDEO_DOWNLOAD_CONFIG_FIELDS: PluginConfigField[] = [
  {
    key: "downloadEnabled",
    label: "启用视频下载并发回 Telegram / Enable video download and Telegram delivery",
    description:
      "仅管理员明确请求时下载单个有权访问的视频；不自动转录。 / Download one authorized video only on an explicit administrator request; no automatic transcription.",
    type: "boolean",
    default: false,
  },
  {
    key: "downloadMaxSeconds",
    label: "下载单视频秒数上限 / Maximum seconds per downloaded video",
    type: "integer",
    default: 600,
    min: 1,
  },
  {
    key: "downloadMaxMb",
    label: "下载单视频大小上限（MB） / Maximum downloaded video size (MB)",
    description:
      "1 MB = 1,000,000 字节。实际仍受 Telegram 50 MB 上传上限限制。 / 1 MB = 1,000,000 bytes. Telegram's 50 MB upload limit still applies.",
    type: "integer",
    default: 45,
    min: 1,
  },
  {
    key: "downloadCacheMinutes",
    label: "服务器视频缓存分钟数 / Server video cache minutes",
    description:
      "过期只清除服务器副本，不撤回 Telegram 文件。 / Expiry removes only the server copy, not the Telegram file.",
    type: "integer",
    default: 30,
    min: 1,
  },
  {
    key: "downloadCacheMb",
    label: "服务器视频缓存预算（MB） / Server video cache budget (MB)",
    description:
      "须至少为有效单视频上限的两倍加 1 MiB，供下载、合并和容器开销使用。 / Must cover twice the effective video size limit plus 1 MiB for download, merge and container overhead.",
    type: "integer",
    default: 512,
    min: 1,
  },
  {
    key: "downloadMinFreeMb",
    label: "保留空闲磁盘空间（MB） / Minimum free disk space (MB)",
    type: "integer",
    default: 1024,
    min: 0,
  },
  {
    key: "downloadDailyJobs",
    label: "每用户每日视频下载任务上限 / Daily video download jobs per user",
    type: "integer",
    default: 5,
    min: 1,
  },
];

function integer(value: unknown, min = 1): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= min;
}

/** No GUI caps: reject unsafe unit conversions and timestamps at the runtime boundary. */
export async function loadVideoDownloadConfiguration(
  manager: PluginManager,
  botId: string,
): Promise<VideoDownloadConfiguration | null> {
  const state = await manager.runtimeConfiguration("hanori.bilibili", botId);
  if (!state || state.configuration.downloadEnabled !== true) return null;
  const value = state.configuration;
  if (
    typeof value.cookie !== "string" ||
    !value.cookie.trim() ||
    !integer(value.downloadMaxSeconds) ||
    !integer(value.downloadMaxMb) ||
    !integer(value.downloadCacheMinutes) ||
    !integer(value.downloadCacheMb) ||
    !integer(value.downloadMinFreeMb, 0) ||
    !integer(value.downloadDailyJobs)
  )
    return null;
  const requestedBytes = value.downloadMaxMb * 1_000_000;
  const cacheTtlMs = value.downloadCacheMinutes * 60_000;
  const maxCacheBytes = value.downloadCacheMb * 1_000_000;
  const minFreeDiskBytes = value.downloadMinFreeMb * 1_000_000;
  if (
    ![requestedBytes, cacheTtlMs, maxCacheBytes, minFreeDiskBytes].every(Number.isSafeInteger) ||
    !Number.isSafeInteger(maxCacheBytes + minFreeDiskBytes) ||
    cacheTtlMs > 8_640_000_000_000_000 - Date.now()
  )
    return null;
  const maxBytes = Math.min(requestedBytes, TELEGRAM_VIDEO_MAX_BYTES);
  if (maxCacheBytes < 2 * maxBytes + VIDEO_DOWNLOAD_TEMP_OVERHEAD_BYTES)
    throw new VideoDownloadError("cache_budget_too_small");
  return {
    revision: state.revision,
    installationRevision: state.installationRevision,
    cookie: value.cookie,
    limits: {
      maxDurationSeconds: value.downloadMaxSeconds,
      maxBytes,
      cacheTtlMs,
      maxCacheBytes,
      minFreeDiskBytes,
      dailyJobs: value.downloadDailyJobs,
    },
  };
}
