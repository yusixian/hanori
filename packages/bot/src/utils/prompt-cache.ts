import { createHash } from "node:crypto";
import { asSchema, type Tool } from "ai";

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 24);
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (typeof value !== "object" || value === null) return value;

  const result: Record<string, unknown> = {};
  for (const key of Object.keys(value).sort()) {
    const item = (value as Record<string, unknown>)[key];
    if (item !== undefined) result[key] = canonicalize(item);
  }
  return result;
}

export function sortToolsForPromptCache(tools: Record<string, Tool>): Record<string, Tool> {
  return Object.fromEntries(
    Object.entries(tools).sort(([left], [right]) => left.localeCompare(right)),
  );
}

export function createToolSchemaHash(tools: Record<string, Tool>): string {
  const descriptors = Object.entries(tools)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([name, tool]) => ({
      name,
      type: tool.type ?? "function",
      title: tool.title,
      description: tool.description,
      inputSchema: asSchema(tool.inputSchema).jsonSchema,
      inputExamples: tool.inputExamples,
      strict: tool.strict,
      providerOptions: tool.providerOptions,
      ...(tool.type === "provider" ? { id: tool.id, args: tool.args } : {}),
    }));
  return digest(JSON.stringify(canonicalize(descriptors)));
}

export function createCacheFingerprint(input: {
  providerId: string;
  model: string;
  staticPrefixHash: string;
  toolSchemaHash: string;
}): string {
  return digest(
    [input.providerId, input.model, input.staticPrefixHash, input.toolSchemaHash].join("\0"),
  );
}
