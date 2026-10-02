import type { PluginTurnSession } from "@cos-tool-bot/shared";
import { jsonSchema, tool, type JSONValue, type Tool } from "ai";

export function createPluginTools(session: PluginTurnSession): Record<string, Tool> {
  return Object.fromEntries(
    session.tools.map((entry) => [
      entry.name,
      tool({
        description: entry.description,
        inputSchema: jsonSchema(entry.inputSchema as JSONValue),
        execute: async (input, options) => {
          options.abortSignal?.throwIfAborted();
          try {
            return await entry.execute(input, options.abortSignal ?? new AbortController().signal);
          } catch {
            options.abortSignal?.throwIfAborted();
            return { error: "plugin_call_failed" };
          }
        },
      }),
    ]),
  );
}
