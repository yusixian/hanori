import type { ModelEntry } from "@cos-tool-bot/shared";
import type { JSONValue } from "ai";

/** The same authored thinking settings apply to chat and task models. */
export function buildModelProviderOptions(
  entry?: ModelEntry,
  providerFormat: "openai" | "gemini" = "openai",
): Record<string, Record<string, JSONValue>> | undefined {
  if (!entry?.thinking) return undefined;
  const enabled = entry.thinking === "enabled";
  if (providerFormat === "gemini")
    return {
      google: {
        thinkingConfig: {
          thinkingBudget: enabled ? (entry.thinkingBudget ?? -1) : 0,
          includeThoughts: enabled,
        },
      },
    };
  const thinking: Record<string, JSONValue> = { type: entry.thinking };
  if (entry.thinkingBudget != null) thinking.budget_tokens = entry.thinkingBudget;
  return { custom: { thinking } };
}
