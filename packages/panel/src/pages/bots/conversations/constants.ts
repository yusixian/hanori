export const COLLAPSE_LINE_THRESHOLD = 4;

export const PANE_MAX_HEIGHT = "h-[calc(100dvh-15rem)] min-h-72 lg:h-[calc(100vh-20rem)]";

export const PENDING_DELETE_MS = 3000;

export const roleStyles: Record<string, string> = {
  user: "border-l-blue-500 bg-blue-500/[0.06]",
  assistant: "border-l-emerald-500 bg-emerald-500/[0.06]",
  context: "border-l-zinc-400 bg-zinc-500/[0.06]",
  system: "border-l-purple-500 bg-purple-500/[0.06]",
  tool_call: "border-l-orange-500 bg-orange-500/[0.06]",
  tool_result: "border-l-cyan-500 bg-cyan-500/[0.06]",
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
