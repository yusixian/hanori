export const DEFAULT_TIMER_MAX_SECONDS = 86_400;
export const MIN_TIMER_MAX_SECONDS = 300;
/** TimerRegistry schedules every timer with one setTimeout, on creation and on restart
 *  recovery. A week keeps both delays far below the 2^31-1 ms overflow point, above which
 *  Node fires the timer immediately. */
export const MAX_TIMER_MAX_SECONDS = 604_800;

/** Resolve the effective set_timer ceiling, clamping stored values into the supported range. */
export function resolveTimerMaxSeconds(seconds?: number): number {
  if (seconds === undefined || !Number.isFinite(seconds)) return DEFAULT_TIMER_MAX_SECONDS;
  return Math.min(Math.max(Math.trunc(seconds), MIN_TIMER_MAX_SECONDS), MAX_TIMER_MAX_SECONDS);
}

export type TimerType = "ai" | "system";
export type TimerStatus = "active" | "processing" | "fired" | "cancelled";

export interface TimerRecord {
  id: string;
  botId: string | null;
  type: TimerType;
  name: string;
  chatId: number | null;
  status: TimerStatus;
  intervalMs: number | null;
  firesAt: string | null;
  createdAt: string;
  firedAt: string | null;
  meta: Record<string, unknown> | null;
}
