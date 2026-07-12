export const COLLAPSE_LINE_THRESHOLD = 4;
export const COLLAPSE_CHARACTER_THRESHOLD = 800;

export const PENDING_DELETE_MS = 3000;

export const roleIconStyles: Record<string, string> = {
  user: "bg-blue-50 text-blue-600",
  assistant: "bg-emerald-50 text-emerald-600",
  context: "bg-slate-100 text-slate-500",
  system: "bg-violet-50 text-violet-600",
  tool_call: "bg-amber-50 text-amber-600",
  tool_result: "bg-cyan-50 text-cyan-600",
};

export const roleLabelKeys: Record<string, string> = {
  user: "conversations.roles.user",
  assistant: "conversations.roles.assistant",
  context: "conversations.roles.context",
  system: "conversations.roles.system",
  tool_call: "conversations.roles.toolCall",
  tool_result: "conversations.roles.toolResult",
};
