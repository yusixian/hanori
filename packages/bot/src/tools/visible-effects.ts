import type { Tool } from "ai";

// Successful calls to these tools mean the event already produced a user-visible
// or durable side effect and must not be replayed as a whole.
export const VISIBLE_EFFECT_TOOL_NAMES = new Set([
  "react_to_message",
  "send_sticker",
  "send_photo",
  "send_voice",
  "send_document",
  "send_media_group",
  "send_poll",
  "send_choice",
  "reply_to_specific",
  "close_poll",
  "set_timer",
  "cancel_timer",
  "send_dice",
  "edit_own_message",
  "delete_own_message",
  "pin_message",
  "set_mood",
  "send_artwork",
]);

// Only tools that are known to be safe to replay belong here. New and dynamic
// tools default to side-effecting so a later delivery failure cannot duplicate
// an unknown external mutation.
export const READ_ONLY_TOOL_NAMES = new Set([
  "get_chat_info",
  "get_current_time",
  "web_search",
  "fetch_webpage",
  "read_file",
  "check_rss",
  "list_rss_feeds",
  "get_profile",
  "search_profiles",
  "search_history",
  "recall_memories",
  "fetch_artwork_info",
  "github_repository",
  "github_read_file",
  "github_list_tree",
  "github_list_issues",
  "github_inspect_workspace",
]);

function succeeded(output: unknown): boolean {
  if (output === null || typeof output !== "object" || Array.isArray(output)) return true;
  const record = output as Record<string, unknown>;
  return !("error" in record) && record["blocked"] !== true && record["success"] !== false;
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
        if (succeeded(output) && !READ_ONLY_TOOL_NAMES.has(name)) onEffect(name);
        return output;
      },
    } as Tool;
  }
  return tracked;
}
