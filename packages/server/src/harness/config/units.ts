import { z } from "zod";

const DURATION_PATTERN = /^(\d+)(s|m|h|d)$/;
const PERCENT_PATTERN = /^(\d{1,3}(?:\.\d+)?)%$/;
const UNIT_MS = { s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000 } as const;

export function parseDuration(value: string): number | null {
  const match = DURATION_PATTERN.exec(value.trim());
  if (!match) return null;
  const ms = Number(match[1]) * UNIT_MS[match[2] as keyof typeof UNIT_MS];
  return ms > 0 && Number.isSafeInteger(ms) ? ms : null;
}

export function parsePercent(value: string): number | null {
  const match = PERCENT_PATTERN.exec(value.trim());
  if (!match) return null;
  const percent = Number(match[1]);
  return percent >= 0 && percent <= 100 ? percent : null;
}

/** Durations stay as their YAML text so export and diff round-trip; consumers call `durationMs`. */
export const durationSchema = z
  .string()
  .refine((value) => parseDuration(value) !== null, "时长格式应为 30s、45m、6h 或 7d");

export const percentSchema = z
  .string()
  .refine((value) => parsePercent(value) !== null, "百分比格式应为 0% 到 100%，例如 10%");

export function durationMs(value: string): number {
  const ms = parseDuration(value);
  if (ms === null) throw new Error(`Invalid duration: ${value}`);
  return ms;
}

export function percentValue(value: string): number {
  const percent = parsePercent(value);
  if (percent === null) throw new Error(`Invalid percent: ${value}`);
  return percent;
}
