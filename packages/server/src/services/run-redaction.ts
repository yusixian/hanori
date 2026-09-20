const BEARER = /\bBearer\s+[A-Za-z0-9._~+/-]+=*/gi;
const SENSITIVE_HEADER = /\b(authorization|proxy-authorization|cookie|set-cookie)\s*:\s*[^\r\n]+/gi;
const SENSITIVE_LABEL =
  "authorization|proxy[-_ ]?authorization|api[-_ ]?key|(?:access|refresh|auth|bearer|bot|session|csrf)[-_ ]?token|token|secret|password|passwd|passphrase|cookie|credential";
const QUOTED_CREDENTIAL = new RegExp(
  `(["'])(${SENSITIVE_LABEL})\\1(\\s*:\\s*)(["'])(.*?)\\4`,
  "gi",
);
const PLAIN_CREDENTIAL = new RegExp(
  `\\b(${SENSITIVE_LABEL})\\b(\\s*[:=]\\s*)([^\\s,;&}\\]]+)`,
  "gi",
);
const MAX_DIAGNOSTIC_DEPTH = 12;
const MAX_DIAGNOSTIC_NODES = 2_000;
const MAX_COLLECTION_ITEMS = 200;
const MAX_STRING_CHARS = 65_536;
const MAX_TOTAL_STRING_CHARS = 131_072;

function isSensitiveKey(key: string): boolean {
  const normalized = key.replace(/[^a-z0-9]/gi, "").toLowerCase();
  const isTokenMetric =
    /^(?:input|output|total|cachedinput|reasoning|prompt|completion|max|min|used|remaining|billable)tokens?$/.test(
      normalized,
    ) || /^tokens?(?:count|usage|limit|used|remaining)$/.test(normalized);
  if (isTokenMetric) return false;
  return (
    normalized === "authorization" ||
    normalized === "proxyauthorization" ||
    normalized === "token" ||
    normalized.endsWith("apikey") ||
    normalized.endsWith("token") ||
    normalized.endsWith("secret") ||
    normalized.endsWith("password") ||
    normalized.endsWith("passwd") ||
    normalized.endsWith("passphrase") ||
    normalized.endsWith("cookie") ||
    normalized.endsWith("credential") ||
    normalized.endsWith("credentials") ||
    normalized.endsWith("privatekey")
  );
}

export function redactDiagnostic(value: unknown, secrets: string[] = []): unknown {
  const seen = new WeakSet<object>();
  let remainingNodes = MAX_DIAGNOSTIC_NODES;
  let remainingStringChars = MAX_TOTAL_STRING_CHARS;
  const scrubString = (input: string) => {
    let result = input
      .replace(SENSITIVE_HEADER, "$1: [REDACTED]")
      .replace(BEARER, "Bearer [REDACTED]")
      .replace(
        QUOTED_CREDENTIAL,
        (_match, quote: string, key: string, separator: string, valueQuote: string) =>
          `${quote}${key}${quote}${separator}${valueQuote}[REDACTED]${valueQuote}`,
      )
      .replace(PLAIN_CREDENTIAL, "$1$2[REDACTED]");
    for (const secret of secrets) {
      if (secret.length >= 4) result = result.split(secret).join("[REDACTED]");
    }
    const allowed = Math.max(0, Math.min(MAX_STRING_CHARS, remainingStringChars));
    if (result.length <= allowed) {
      remainingStringChars -= result.length;
      return result;
    }
    remainingStringChars -= allowed;
    return `${result.slice(0, allowed)}… [truncated: diagnostic text limit]`;
  };
  const visit = (input: unknown, key?: string, depth = 0): unknown => {
    if (key && isSensitiveKey(key)) return "[REDACTED]";
    if (remainingNodes <= 0) return "[truncated: diagnostic node limit]";
    remainingNodes--;
    if (typeof input === "string") return scrubString(input);
    if (typeof input === "bigint") return input.toString();
    if (input instanceof Date)
      return Number.isNaN(input.getTime()) ? "Invalid Date" : input.toISOString();
    if (input instanceof Error) {
      if (seen.has(input)) return "[Circular]";
      if (depth >= MAX_DIAGNOSTIC_DEPTH) return "[truncated: diagnostic depth limit]";
      seen.add(input);
      const entries = Object.entries(input);
      const diagnosticFields = Object.fromEntries(
        entries
          .slice(0, MAX_COLLECTION_ITEMS)
          .flatMap(([name, item]) =>
            name === "name" || name === "message" || name === "stack" || name === "cause"
              ? []
              : [[name, visit(item, name, depth + 1)]],
          ),
      );
      return {
        name: input.name,
        message: scrubString(input.message),
        stack: input.stack ? scrubString(input.stack) : undefined,
        cause: visit(input.cause, "cause", depth + 1),
        ...diagnosticFields,
        ...(entries.length > MAX_COLLECTION_ITEMS
          ? {
              __truncated__: `[truncated: ${entries.length - MAX_COLLECTION_ITEMS} properties omitted]`,
            }
          : {}),
      };
    }
    if (!input || typeof input !== "object") return input;
    if (seen.has(input)) return "[Circular]";
    if (depth >= MAX_DIAGNOSTIC_DEPTH) return "[truncated: diagnostic depth limit]";
    seen.add(input);
    if (Array.isArray(input)) {
      const result = input
        .slice(0, MAX_COLLECTION_ITEMS)
        .map((item) => visit(item, undefined, depth + 1));
      if (input.length > MAX_COLLECTION_ITEMS) {
        result.push(`[truncated: ${input.length - MAX_COLLECTION_ITEMS} items omitted]`);
      }
      return result;
    }
    const entries = Object.entries(input as Record<string, unknown>);
    return {
      ...Object.fromEntries(
        entries
          .slice(0, MAX_COLLECTION_ITEMS)
          .map(([name, item]) => [name, visit(item, name, depth + 1)]),
      ),
      ...(entries.length > MAX_COLLECTION_ITEMS
        ? {
            __truncated__: `[truncated: ${entries.length - MAX_COLLECTION_ITEMS} properties omitted]`,
          }
        : {}),
    };
  };
  return visit(value);
}

export type FailureReason =
  | "channel_event_invalid"
  | "handler_failed"
  | "provider_request_failed"
  | "provider_stream_failed"
  | "provider_empty_output"
  | "tool_failed"
  | "channel_api_failed"
  | "timed_out"
  | "cancelled"
  | "interrupted";

export function classifyProviderError(error: unknown, streamStarted: boolean): FailureReason {
  const name = error instanceof Error ? error.name : "";
  const message = error instanceof Error ? error.message : String(error);
  if (name === "TimeoutError" || /timeout|timed out/i.test(message)) return "timed_out";
  if (name === "AbortError" || /aborted|cancelled/i.test(message)) return "cancelled";
  return streamStarted ? "provider_stream_failed" : "provider_request_failed";
}
