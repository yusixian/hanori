/** Format milliseconds as a human-readable duration string (e.g. "5s", "3m 20s", "2h 15m"). */
export function formatDuration(ms: number): string {
  if (ms <= 0) return "0s";
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m`;
}
