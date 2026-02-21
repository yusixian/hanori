import type { BotStatus } from "@cos-tool-bot/shared";

export function formatUptime(ms: number | null): string {
  if (ms == null) return "-";
  const seconds = Math.floor(ms / 1000);
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  return `${h}h ${m}m ${s}s`;
}

export const statusBadge: Record<
  BotStatus,
  { label: string; variant: "success" | "destructive" | "warning" }
> = {
  running: { label: "Running", variant: "success" },
  stopped: { label: "Stopped", variant: "destructive" },
  restarting: { label: "Restarting", variant: "warning" },
};
