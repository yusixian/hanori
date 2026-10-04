const HTTP_TIMEOUT_CODES = new Set([
  "UND_ERR_BODY_TIMEOUT",
  "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_CONNECT_TIMEOUT",
]);

/** Fetch can hide a transport timeout inside a generic TypeError's cause. */
export function isTimeoutError(error: unknown): boolean {
  const seen = new Set<object>();
  for (let depth = 0; depth < 8; depth++) {
    if (typeof error === "string") return /timeout|timed out/i.test(error);
    if (!error || typeof error !== "object" || seen.has(error)) return false;
    seen.add(error);
    const detail = error as { name?: unknown; message?: unknown; code?: unknown; cause?: unknown };
    if (
      detail.name === "TimeoutError" ||
      (typeof detail.code === "string" && HTTP_TIMEOUT_CODES.has(detail.code)) ||
      (typeof detail.message === "string" && /timeout|timed out/i.test(detail.message))
    ) {
      return true;
    }
    error = detail.cause;
  }
  return false;
}
