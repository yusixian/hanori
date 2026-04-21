export const COLLAPSE_LINE_THRESHOLD = 4;

export const PANE_MAX_HEIGHT = "max-h-[calc(100vh-340px)]";

export const PENDING_DELETE_MS = 3000;

export const roleStyles: Record<string, string> = {
  user: "bg-blue-500/10 text-blue-700 dark:text-blue-300",
  assistant: "bg-green-500/10 text-green-700 dark:text-green-300",
  context: "bg-zinc-500/10 text-zinc-600 dark:text-zinc-400",
  system: "bg-purple-500/10 text-purple-700 dark:text-purple-300",
  tool_call: "bg-orange-500/10 text-orange-700 dark:text-orange-300",
  tool_result: "bg-cyan-500/10 text-cyan-700 dark:text-cyan-300",
};

export const roleLabels: Record<string, string> = {
  user: "User",
  assistant: "AI",
  context: "Context",
  system: "System",
  tool_call: "Tool Call",
  tool_result: "Tool Result",
};

export const roleColors: Record<string, string> = {
  user: "bg-blue-500",
  assistant: "bg-green-500",
  tool_call: "bg-orange-500",
  tool_result: "bg-cyan-500",
  system: "bg-purple-500",
  context: "bg-zinc-400",
};
