export const COLLAPSE_LINE_THRESHOLD = 4;
export const COLLAPSE_CHARACTER_THRESHOLD = 800;

export const PENDING_DELETE_MS = 3000;

export const roleIconStyles: Record<string, string> = {
  user: "bg-secondary text-secondary-foreground",
  assistant: "bg-accent text-primary",
  context: "bg-surface-subtle text-muted-foreground",
  system: "bg-lilac text-lilac-foreground",
  tool_call: "bg-surface-subtle text-muted-foreground",
  tool_result: "bg-secondary text-secondary-foreground",
};

export const roleLabelKeys: Record<string, string> = {
  user: "conversations.roles.user",
  assistant: "conversations.roles.assistant",
  context: "conversations.roles.context",
  system: "conversations.roles.system",
  tool_call: "conversations.roles.toolCall",
  tool_result: "conversations.roles.toolResult",
};
