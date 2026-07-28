interface CacheAwareUsage {
  inputTokenDetails?: {
    cacheReadTokens?: number;
    cacheWriteTokens?: number;
  };
  raw?: unknown;
}

export interface CacheTokenUsage {
  /** Undefined means the provider did not expose a cache-read measurement. */
  cacheReadTokens?: number;
  /** Undefined means the provider did not expose a cache-write measurement. */
  cacheWriteTokens?: number;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function firstNumber(...values: unknown[]): number | undefined {
  for (const value of values) {
    const number = finiteNumber(value);
    if (number !== undefined) return number;
  }
  return undefined;
}

/**
 * Preserve the difference between an observed cache miss (0) and a provider that
 * did not report cache usage. Some OpenAI-compatible adapters normalize a missing
 * `cached_tokens` field to zero, so raw provider usage is authoritative for zero.
 */
function extractSingleCacheTokenUsage(usage: CacheAwareUsage): CacheTokenUsage {
  const raw = asRecord(usage.raw);
  const promptDetails = asRecord(raw?.["prompt_tokens_details"]);

  const rawRead = firstNumber(
    promptDetails?.["cached_tokens"],
    promptDetails?.["cache_read_tokens"],
    raw?.["cache_read_input_tokens"],
    raw?.["cached_content_token_count"],
    raw?.["cachedContentTokenCount"],
  );
  const rawWrite = firstNumber(
    promptDetails?.["cache_write_tokens"],
    raw?.["cache_creation_input_tokens"],
    raw?.["cache_write_input_tokens"],
  );
  const normalizedRead = finiteNumber(usage.inputTokenDetails?.cacheReadTokens);
  const normalizedWrite = finiteNumber(usage.inputTokenDetails?.cacheWriteTokens);

  return {
    ...(rawRead !== undefined || (normalizedRead !== undefined && normalizedRead > 0)
      ? { cacheReadTokens: rawRead ?? normalizedRead }
      : {}),
    ...(rawWrite !== undefined || (normalizedWrite !== undefined && normalizedWrite > 0)
      ? { cacheWriteTokens: rawWrite ?? normalizedWrite }
      : {}),
  };
}

export function extractCacheTokenUsage(
  usage: CacheAwareUsage,
  stepUsages: CacheAwareUsage[] = [],
): CacheTokenUsage {
  if (stepUsages.length > 0) {
    const steps = stepUsages.map(extractSingleCacheTokenUsage);
    const everyReadObserved = steps.every((step) => step.cacheReadTokens !== undefined);
    const everyWriteObserved = steps.every((step) => step.cacheWriteTokens !== undefined);
    return {
      ...(everyReadObserved
        ? { cacheReadTokens: steps.reduce((total, step) => total + step.cacheReadTokens!, 0) }
        : {}),
      ...(everyWriteObserved
        ? { cacheWriteTokens: steps.reduce((total, step) => total + step.cacheWriteTokens!, 0) }
        : {}),
    };
  }
  return extractSingleCacheTokenUsage(usage);
}
