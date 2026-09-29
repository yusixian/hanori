/** Inclusive range of a numeric AI setting. `integer` settings reject fractional values. */
export interface NumericSettingBounds {
  readonly min: number;
  readonly max: number;
  readonly integer: boolean;
}

/** Fields written both by the admin AI settings and by the Mini App group editor. */
export const AI_SETTING_BOUNDS = {
  randomReplyPercent: { min: 0, max: 100, integer: false },
  randomReplyCooldown: { min: 0, max: 86_400, integer: true },
  maxContextMessages: { min: 1, max: 100, integer: true },
  groupHistoryMaxTokens: { min: 2_000, max: 64_000, integer: true },
} as const satisfies Record<string, NumericSettingBounds>;

export function isWithinBounds(value: unknown, bounds: NumericSettingBounds): value is number {
  return (
    typeof value === "number" &&
    (!bounds.integer || Number.isInteger(value)) &&
    value >= bounds.min &&
    value <= bounds.max
  );
}

/** Rounds integer settings, then clamps into range. */
export function clampToBounds(value: number, bounds: NumericSettingBounds): number {
  const rounded = bounds.integer ? Math.round(value) : value;
  return Math.min(Math.max(rounded, bounds.min), bounds.max);
}
