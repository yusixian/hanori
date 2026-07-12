const SENSITIVE_KEY = /authorization|api[-_]?key|token|secret|password|cookie|credential/i;
const BEARER = /\bBearer\s+[A-Za-z0-9._~+/-]+=*/gi;

export function redactDiagnostic(value: unknown, secrets: string[] = []): unknown {
  const seen = new WeakSet<object>();
  const scrubString = (input: string) => {
    let result = input.replace(BEARER, "Bearer [REDACTED]");
    for (const secret of secrets) {
      if (secret.length >= 4) result = result.split(secret).join("[REDACTED]");
    }
    return result.length > 65_536 ? `${result.slice(0, 65_536)}… [truncated]` : result;
  };
  const visit = (input: unknown, key?: string): unknown => {
    if (key && SENSITIVE_KEY.test(key)) return "[REDACTED]";
    if (typeof input === "string") return scrubString(input);
    if (input instanceof Error) {
      if (seen.has(input)) return "[Circular]";
      seen.add(input);
      const diagnosticFields = Object.fromEntries(
        Object.entries(input).flatMap(([name, item]) =>
          name === "name" || name === "message" || name === "stack" || name === "cause"
            ? []
            : [[name, visit(item, name)]],
        ),
      );
      return {
        name: input.name,
        message: scrubString(input.message),
        stack: input.stack ? scrubString(input.stack) : undefined,
        cause: visit(input.cause),
        ...diagnosticFields,
      };
    }
    if (!input || typeof input !== "object") return input;
    if (seen.has(input)) return "[Circular]";
    seen.add(input);
    if (Array.isArray(input)) return input.map((item) => visit(item));
    return Object.fromEntries(
      Object.entries(input as Record<string, unknown>).map(([name, item]) => [
        name,
        visit(item, name),
      ]),
    );
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
  | "cancelled";

export function classifyProviderError(error: unknown, streamStarted: boolean): FailureReason {
  const name = error instanceof Error ? error.name : "";
  const message = error instanceof Error ? error.message : String(error);
  if (name === "AbortError" || /aborted|cancelled/i.test(message)) return "cancelled";
  if (/timeout|timed out/i.test(message)) return "timed_out";
  return streamStarted ? "provider_stream_failed" : "provider_request_failed";
}
