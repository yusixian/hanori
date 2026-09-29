import type { NumericSettingBounds } from "@cos-tool-bot/shared";

/** Number-input attributes for a shared bound; decimal settings need `step="any"` to stay valid. */
export function settingInputBounds(bounds: NumericSettingBounds): {
  min: number;
  max: number;
  step: number | "any";
} {
  return { min: bounds.min, max: bounds.max, step: bounds.integer ? 1 : "any" };
}
