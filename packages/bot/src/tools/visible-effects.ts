import type { Tool } from "ai";
import { isReadOnlyTool } from "./descriptors.js";

export { VISIBLE_EFFECT_TOOL_NAMES, READ_ONLY_TOOL_NAMES } from "./descriptors.js";

function succeeded(output: unknown): boolean {
  if (output === null || typeof output !== "object" || Array.isArray(output)) return true;
  const record = output as Record<string, unknown>;
  return (
    !("error" in record) &&
    record["blocked"] !== true &&
    record["success"] !== false &&
    record["accepted"] !== false &&
    record["ok"] !== false
  );
}

export function trackSuccessfulToolEffects(
  tools: Record<string, Tool>,
  onEffect: (toolName: string) => void,
): Record<string, Tool> {
  const tracked: Record<string, Tool> = {};
  for (const [name, tool] of Object.entries(tools)) {
    if (!("execute" in tool) || !tool.execute) {
      tracked[name] = tool;
      continue;
    }
    const execute = tool.execute as (args: unknown, options: unknown) => PromiseLike<unknown>;
    tracked[name] = {
      ...tool,
      execute: async (args: unknown, options: unknown) => {
        const output = await execute(args, options);
        if (succeeded(output) && !isReadOnlyTool(name, tool)) onEffect(name);
        return output;
      },
    } as Tool;
  }
  return tracked;
}
