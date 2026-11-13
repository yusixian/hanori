import { APICallError } from "ai";
import { toToolLogValue } from "./tool-log.js";

/** Keep transport diagnostics separate from potentially huge requestBodyValues. */
export function modelErrorSummary(error: unknown, secrets: readonly string[] = []) {
  const bounded = (text: string, limit: number) =>
    String(toToolLogValue(text, secrets)).slice(0, limit);
  const value = error instanceof Error ? error : new Error(String(error));
  const api = APICallError.isInstance(error) ? error : undefined;
  let upstream: Record<string, unknown> | undefined;
  if (api?.responseBody && api.responseBody.length <= 32_768) {
    try {
      const body = JSON.parse(api.responseBody);
      if (body?.error && typeof body.error === "object") upstream = body.error;
    } catch {
      /* Non-JSON errors still retain the SDK message and HTTP status. */
    }
  }
  const headers = api?.responseHeaders;
  const id = headers?.["x-request-id"] ?? headers?.["request-id"] ?? headers?.["x-goog-request-id"];
  let endpoint: string | undefined;
  if (api) {
    try {
      const url = new URL(api.url);
      endpoint = `${url.origin}${url.pathname}`;
    } catch {
      /* Invalid URL is not logged. */
    }
  }
  return toToolLogValue(
    {
      name: value.name,
      message: bounded(value.message, 1000),
      ...(api ? { statusCode: api.statusCode, retryable: api.isRetryable, endpoint } : {}),
      ...(typeof upstream?.code === "string" || typeof upstream?.code === "number"
        ? { code: bounded(String(upstream.code), 120) }
        : {}),
      ...(typeof upstream?.type === "string" ? { type: bounded(upstream.type, 120) } : {}),
      ...(id ? { requestId: bounded(id, 200) } : {}),
    },
    secrets,
  );
}
