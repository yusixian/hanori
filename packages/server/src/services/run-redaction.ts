import {
  isTimeoutError,
  isDiagnosticCredentialKey,
  redactDiagnosticText,
} from "@cos-tool-bot/shared";

const MAX_DIAGNOSTIC_DEPTH = 12;
const MAX_DIAGNOSTIC_NODES = 2_000;
const MAX_COLLECTION_ITEMS = 200;
const MAX_STRING_CHARS = 65_536;
const MAX_TOTAL_STRING_CHARS = 131_072;

export function redactDiagnostic(value: unknown, secrets: string[] = []): unknown {
  const seen = new WeakSet<object>();
  let remainingNodes = MAX_DIAGNOSTIC_NODES;
  let remainingStringChars = MAX_TOTAL_STRING_CHARS;
  const scrubString = (input: string) => {
    const result = redactDiagnosticText(input, secrets);
    const allowed = Math.max(0, Math.min(MAX_STRING_CHARS, remainingStringChars));
    if (result.length <= allowed) {
      remainingStringChars -= result.length;
      return result;
    }
    remainingStringChars -= allowed;
    return `${result.slice(0, allowed)}… [truncated: diagnostic text limit]`;
  };
  const visit = (input: unknown, key?: string, depth = 0): unknown => {
    if (key && isDiagnosticCredentialKey(key)) return "[REDACTED]";
    if (remainingNodes <= 0) return "[truncated: diagnostic node limit]";
    remainingNodes--;
    if (typeof input === "string") return scrubString(input);
    if (typeof input === "bigint") return input.toString();
    if (input instanceof Date)
      return Number.isNaN(input.getTime()) ? "Invalid Date" : input.toISOString();
    if (ArrayBuffer.isView(input)) {
      return { type: scrubString(input.constructor.name), byteLength: input.byteLength };
    }
    if (input instanceof ArrayBuffer) return { type: "ArrayBuffer", byteLength: input.byteLength };
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
        name: scrubString(input.name),
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
  if (isTimeoutError(error)) return "timed_out";
  if (name === "AbortError" || /aborted|cancelled/i.test(message)) return "cancelled";
  return streamStarted ? "provider_stream_failed" : "provider_request_failed";
}
