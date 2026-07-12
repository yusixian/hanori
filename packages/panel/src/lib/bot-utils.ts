import type { BotStatus } from "@cos-tool-bot/shared";

export function getUptimeParts(ms: number | null) {
  if (ms == null) return null;
  const seconds = Math.floor(ms / 1000);
  return {
    hours: Math.floor(seconds / 3600),
    minutes: Math.floor((seconds % 3600) / 60),
    seconds: seconds % 60,
  };
}

export const statusBadgeVariant: Record<BotStatus, "success" | "destructive" | "warning"> = {
  running: "success",
  stopped: "destructive",
  restarting: "warning",
};
