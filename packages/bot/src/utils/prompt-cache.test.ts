import { jsonSchema, tool } from "ai";
import { describe, expect, it } from "vitest";
import {
  createCacheFingerprint,
  createToolSchemaHash,
  sortToolsForPromptCache,
} from "./prompt-cache.js";

function exampleTool(description: string, properties: Record<string, unknown>) {
  return tool({
    description,
    inputSchema: jsonSchema({ type: "object", properties }),
  });
}

describe("prompt cache fingerprints", () => {
  it("sorts tool names before sending them to the provider", () => {
    const tools = {
      zebra: exampleTool("z", {}),
      alpha: exampleTool("a", {}),
    };

    expect(Object.keys(sortToolsForPromptCache(tools))).toEqual(["alpha", "zebra"]);
  });

  it("produces the same schema hash for different insertion and JSON key orders", () => {
    const first = {
      zebra: exampleTool("z", { count: { type: "number" }, text: { type: "string" } }),
      alpha: exampleTool("a", {}),
    };
    const second = {
      alpha: exampleTool("a", {}),
      zebra: exampleTool("z", { text: { type: "string" }, count: { type: "number" } }),
    };

    expect(createToolSchemaHash(sortToolsForPromptCache(first))).toBe(
      createToolSchemaHash(sortToolsForPromptCache(second)),
    );
  });

  it("changes the cache fingerprint when a prompt-visible input changes", () => {
    const base = {
      providerId: "provider-a",
      model: "model-a",
      staticPrefixHash: "static-a",
      toolSchemaHash: "tools-a",
    };

    expect(createCacheFingerprint(base)).not.toBe(
      createCacheFingerprint({ ...base, toolSchemaHash: "tools-b" }),
    );
    expect(createCacheFingerprint(base)).not.toBe(
      createCacheFingerprint({ ...base, staticPrefixHash: "static-b" }),
    );
  });
});
