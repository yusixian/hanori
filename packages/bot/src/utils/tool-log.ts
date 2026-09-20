import type { BotLogEntry } from "@cos-tool-bot/shared";
import type { Tool } from "ai";

const BEARER_VALUE = /\bBearer\s+[A-Za-z0-9._~+/-]+=*/gi;
const MAX_STRING_CHARS = 16_384;
const MAX_SERIALIZED_CHARS = 64_000;
const MAX_DEPTH = 12;

function isSensitiveKey(key: string): boolean {
  const normalized = key.replace(/[-_]/g, "").toLowerCase();
  return (
    [
      "authorization",
      "apikey",
      "token",
      "accesstoken",
      "refreshtoken",
      "bottoken",
      "secret",
      "clientsecret",
      "password",
      "cookie",
      "setcookie",
      "credential",
    ].includes(normalized) ||
    normalized.endsWith("apikey") ||
    normalized.endsWith("authtoken") ||
    normalized.endsWith("password") ||
    normalized.endsWith("secret") ||
    normalized.endsWith("credential")
  );
}

function truncateString(value: string): string {
  if (/^data:[^,]+;base64,/i.test(value)) return `[binary data URL: ${value.length} chars]`;
  const redacted = value.replace(BEARER_VALUE, "Bearer [REDACTED]");
  return redacted.length > MAX_STRING_CHARS
    ? `${redacted.slice(0, MAX_STRING_CHARS)}… [truncated ${redacted.length - MAX_STRING_CHARS} chars]`
    : redacted;
}

function normalizeToolLogValue(
  value: unknown,
  seen: WeakSet<object>,
  depth: number,
  key?: string,
): unknown {
  if (key && isSensitiveKey(key)) return "[REDACTED]";
  if (typeof value === "string") return truncateString(value);
  if (typeof value === "bigint") return `${value}n`;
  if (typeof value === "number") return Number.isFinite(value) ? value : String(value);
  if (typeof value === "boolean" || value === null) return value;
  if (value === undefined) return "[undefined]";
  if (typeof value === "function") return `[Function ${value.name || "anonymous"}]`;
  if (typeof value === "symbol") return value.toString();
  if (depth >= MAX_DEPTH) return "[Max depth reached]";

  if (value instanceof URL) return truncateString(value.toString());
  if (value instanceof Date) return value.toISOString();
  if (ArrayBuffer.isView(value)) {
    return { type: value.constructor.name, byteLength: value.byteLength };
  }
  if (value instanceof ArrayBuffer) return { type: "ArrayBuffer", byteLength: value.byteLength };
  if (value instanceof Error) {
    return {
      name: value.name,
      ...Object.fromEntries(
        Object.entries(value).map(([name, item]) => [
          name,
          normalizeToolLogValue(item, seen, depth + 1, name),
        ]),
      ),
      message: truncateString(value.message),
      stack: value.stack ? truncateString(value.stack) : undefined,
      cause: normalizeToolLogValue(value.cause, seen, depth + 1),
    };
  }
  if (typeof value !== "object") return String(value);
  if (seen.has(value)) return "[Circular]";
  seen.add(value);

  if (Array.isArray(value)) {
    return value.map((item) => normalizeToolLogValue(item, seen, depth + 1));
  }
  if (value instanceof Map) {
    return Object.fromEntries(
      [...value.entries()].map(([entryKey, item]) => [
        String(entryKey),
        normalizeToolLogValue(item, seen, depth + 1, String(entryKey)),
      ]),
    );
  }
  if (value instanceof Set) {
    return [...value].map((item) => normalizeToolLogValue(item, seen, depth + 1));
  }

  return Object.fromEntries(
    Object.entries(value).map(([name, item]) => [
      name,
      normalizeToolLogValue(item, seen, depth + 1, name),
    ]),
  );
}

/** Preserve useful tool diagnostics while keeping database JSON bounded and credential-safe. */
export function toToolLogValue(value: unknown, secrets: readonly string[] = []): unknown {
  const normalized = normalizeToolLogValue(value, new WeakSet(), 0);
  let serialized = JSON.stringify(normalized);
  if (!serialized) return normalized;
  for (const secret of secrets) {
    if (secret.length >= 4)
      serialized = serialized.split(JSON.stringify(secret).slice(1, -1)).join("[REDACTED]");
  }
  if (serialized.length <= MAX_SERIALIZED_CHARS) return JSON.parse(serialized);
  return {
    truncated: true,
    serializedLength: serialized.length,
    preview: `${serialized.slice(0, MAX_SERIALIZED_CHARS)}…`,
  };
}

function serializedLength(value: unknown): number {
  if (typeof value === "string") return value.length;
  try {
    return JSON.stringify(value)?.length ?? 0;
  } catch {
    return 0;
  }
}

export function wrapToolsWithLogging(
  tools: Record<string, Tool>,
  options: {
    onLog?: (entry: BotLogEntry) => void | Promise<void>;
    getStep?: () => number;
  },
): Record<string, Tool> {
  if (!options.onLog) return tools;

  const wrapped: Record<string, Tool> = {};
  let callSequence = 0;
  const log = async (entry: BotLogEntry) => {
    await Promise.resolve(options.onLog?.(entry)).catch(() => {});
  };

  for (const [name, tool] of Object.entries(tools)) {
    if (!("execute" in tool) || typeof tool.execute !== "function") {
      wrapped[name] = tool;
      continue;
    }
    const originalExecute = tool.execute;
    wrapped[name] = {
      ...tool,
      execute: async (...args: Parameters<typeof originalExecute>) => {
        const call = ++callSequence;
        const input = args[0];
        const executionOptions = args[1] as { toolCallId?: unknown } | undefined;
        const toolCallId =
          typeof executionOptions?.toolCallId === "string"
            ? executionOptions.toolCallId
            : undefined;
        const startedAt = Date.now();
        await log({
          level: "debug",
          message: "AI tool call",
          meta: {
            step: options.getStep?.(),
            call,
            toolName: name,
            input: toToolLogValue(input),
            argsLength: serializedLength(input),
            toolCallId,
          },
        });
        try {
          const output = await originalExecute(...args);
          await log({
            level: "debug",
            message: "AI tool result",
            meta: {
              step: options.getStep?.(),
              call,
              toolName: name,
              success: true,
              durationMs: Date.now() - startedAt,
              output: toToolLogValue(output),
              resultLength: serializedLength(output),
              toolCallId,
            },
          });
          return output;
        } catch (error) {
          await log({
            level: "debug",
            message: "AI tool result",
            meta: {
              step: options.getStep?.(),
              call,
              toolName: name,
              success: false,
              durationMs: Date.now() - startedAt,
              error: toToolLogValue(error),
              toolCallId,
            },
          });
          throw error;
        }
      },
    };
  }
  return wrapped;
}
