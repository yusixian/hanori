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
