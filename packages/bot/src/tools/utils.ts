import type { JSONValue } from "ai";
import { jsonSchema } from "ai";
import { z } from "zod";

/**
 * Convert a Zod v4 schema to an AI SDK-compatible JSON Schema.
 * The AI SDK internally uses `zod-to-json-schema` (designed for Zod v3),
 * which produces invalid output with Zod v4. This helper uses Zod v4's
 * native `z.toJSONSchema()` and wraps the result with AI SDK's `jsonSchema()`.
 */
export function zodToAiSchema<T extends z.ZodType>(schema: T) {
  const json = z.toJSONSchema(schema, { unrepresentable: "any", io: "input" });
  return jsonSchema<z.infer<T>>(json as JSONValue);
}

/**
 * Tracks which side-effect tools have already been executed within a single
 * `generateText` call. Shared across all tool factories for one request.
 */
export interface OnceGuardContext {
  /** Returns true if the tool has already fired. */
  hasFired(toolName: string): boolean;
  /** Marks the tool as fired. */
  markFired(toolName: string): void;
}

export function createOnceGuard(): OnceGuardContext {
  const fired = new Set<string>();
  return {
    hasFired: (name) => fired.has(name),
    markFired: (name) => {
      fired.add(name);
    },
  };
}

/**
 * Wraps a tool's execute function so it can only run once per generateText call.
 * Subsequent invocations return a blocked message instead of executing.
 */
/** `any` is needed to match AI SDK's dynamic tool execute signature */
export function wrapOnce(
  toolName: string,
  guard: OnceGuardContext,
  execute: (...args: any[]) => PromiseLike<any>,
): (...args: any[]) => PromiseLike<any> {
  return async (...args: any[]) => {
    if (guard.hasFired(toolName)) {
      return {
        blocked: true,
        reason: `Tool "${toolName}" has already been executed in this request. Duplicate call blocked.`,
      };
    }
    guard.markFired(toolName);
    return execute(...args);
  };
}
