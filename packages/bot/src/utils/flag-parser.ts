/**
 * Shared flag parsing and validation utilities for bot commands.
 * Used by /draw and /imgcfg commands.
 */

/** Build a regex that matches any of the given flag keys followed by whitespace or end-of-string. */
export function buildFlagPattern(keys: string[]): RegExp {
  const sorted = [...keys].sort((a, b) => b.length - a.length);
  return new RegExp(
    `(${sorted.map((f) => f.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})(?:\\s|$)`,
    "g",
  );
}

/**
 * Parse an input string into a preamble (text before the first flag) and a map of flag→value pairs.
 * The pattern must be built with `buildFlagPattern`.
 */
export function parseFlagsFromInput(
  input: string,
  pattern: RegExp,
): { preamble: string; flags: Map<string, string> } {
  // Reset lastIndex for global regex
  pattern.lastIndex = 0;

  const positions: Array<{ flag: string; start: number; valueStart: number }> = [];
  for (const match of input.matchAll(pattern)) {
    const flagText = match[1]!;
    positions.push({
      flag: flagText,
      start: match.index,
      // valueStart is after the flag + the separator (space or end)
      valueStart: match.index + match[0].length,
    });
  }

  if (positions.length === 0) {
    return { preamble: input.trim(), flags: new Map() };
  }

  const preamble = input.slice(0, positions[0]!.start).trim();
  const flags = new Map<string, string>();

  for (let i = 0; i < positions.length; i++) {
    const pos = positions[i]!;
    const nextStart = positions[i + 1]?.start ?? input.length;
    const value = input.slice(pos.valueStart, nextStart).trim();
    flags.set(pos.flag, value);
  }

  return { preamble, flags };
}

// --- Validators ---

export function validateInt(
  value: string,
  min: number,
  max: number,
  label: string,
): number | string {
  const n = Number.parseInt(value, 10);
  if (Number.isNaN(n)) return `${label}: 需要整数，收到 "${value}"`;
  if (n < min || n > max) return `${label}: 范围 ${min}-${max}，收到 ${n}`;
  return n;
}

export function validateFloat(
  value: string,
  min: number,
  max: number,
  label: string,
): number | string {
  const n = Number.parseFloat(value);
  if (Number.isNaN(n)) return `${label}: 需要数字，收到 "${value}"`;
  if (n < min || n > max) return `${label}: 范围 ${min}-${max}，收到 ${n}`;
  return n;
}

export function validateBool(value: string, label: string): boolean | string {
  const v = value.toLowerCase().trim();
  if (v === "" || v === "on" || v === "true" || v === "1") return true;
  if (v === "off" || v === "false" || v === "0") return false;
  return `${label}: 需要 on/off，收到 "${value}"`;
}
