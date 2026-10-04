import { escapeHtml } from "@cos-tool-bot/bot/utils/format";
import type { MediaJobRow } from "./contracts.js";

const safeFailures = new Set([
  "job_failed",
  "interrupted",
  "interrupted_transcription",
  "configuration_required",
  "provider_cancellation_unavailable",
  "expired",
]);

export function formatMediaJobNotice(job: Pick<MediaJobRow, "id" | "status" | "error">): string {
  const status =
    job.status === "completed"
      ? "已完成 / Completed"
      : job.status === "cancelled"
        ? "已取消 / Cancelled"
        : job.status === "expired"
          ? "已过期 / Expired"
          : "未完成 / Failed";
  const failure =
    job.status === "failed"
      ? `\n原因 / Reason: <code>${job.error && safeFailures.has(job.error) ? job.error : "job_failed"}</code>`
      : "";
  return `音频转录任务 / Audio transcription: <code>${escapeHtml(job.id)}</code>\n${status}${failure}`;
}
