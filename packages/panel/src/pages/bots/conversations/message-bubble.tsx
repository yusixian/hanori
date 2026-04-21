import { cn } from "@/lib/utils";
import { ChevronDown, ChevronUp, Trash2 } from "lucide-react";
import { useState } from "react";
import { CollapsibleContent } from "./collapsible-content";
import { roleLabels, roleStyles } from "./constants";
import type { ConversationMessage } from "./types";

function UsageBadge({ meta }: { meta: Record<string, unknown> }) {
  const usage = meta.usage as Record<string, number> | undefined;
  const model = meta.model as string | undefined;
  const trigger = meta.trigger as string | undefined;

  if (!usage && !model) return null;

  return (
    <div className="mt-2 flex flex-wrap gap-2">
      {model && (
        <span className="rounded bg-black/5 px-1.5 py-0.5 font-mono text-[10px] dark:bg-white/10">
          {model}
        </span>
      )}
      {trigger && (
        <span className="rounded bg-black/5 px-1.5 py-0.5 text-[10px] dark:bg-white/10">
          trigger: {trigger}
        </span>
      )}
      {usage && (
        <span className="rounded bg-black/5 px-1.5 py-0.5 font-mono text-[10px] dark:bg-white/10">
          {usage.prompt_tokens}+{usage.completion_tokens}={usage.total_tokens} tokens
        </span>
      )}
    </div>
  );
}

function ToolCallContent({ meta }: { meta: Record<string, unknown> }) {
  const [expanded, setExpanded] = useState(false);
  const toolName = meta.toolName as string;
  const args = meta.args as string | undefined;

  let parsedArgs: string | undefined;
  if (args) {
    try {
      parsedArgs = JSON.stringify(JSON.parse(args), null, 2);
    } catch {
      parsedArgs = args;
    }
  }

  return (
    <div>
      <p className="text-sm font-medium">{toolName}()</p>
      {parsedArgs && (
        <>
          <button
            type="button"
            className="mt-1 flex items-center gap-1 text-xs opacity-60 hover:opacity-100"
            onClick={() => setExpanded((v) => !v)}
          >
            {expanded ? (
              <>
                <ChevronUp className="h-3 w-3" /> Hide args
              </>
            ) : (
              <>
                <ChevronDown className="h-3 w-3" /> Show args
              </>
            )}
          </button>
          {expanded && (
            <pre className="mt-1 max-h-60 overflow-auto rounded bg-black/5 p-2 font-mono text-xs dark:bg-white/5">
              {parsedArgs}
            </pre>
          )}
        </>
      )}
    </div>
  );
}

export function MessageBubble({
  msg,
  onDelete,
  pendingDelete,
}: {
  msg: ConversationMessage;
  onDelete?: (messageId: number) => void;
  pendingDelete?: boolean;
}) {
  const isToolCall = msg.role === "tool_call" && msg.meta;
  const isAssistantWithMeta = msg.role === "assistant" && msg.meta;
  const needsCollapse =
    msg.role === "system" || msg.role === "tool_result" || msg.role === "context";

  return (
    <div
      className={cn(
        "group/msg rounded-md p-3",
        roleStyles[msg.role] ?? "bg-zinc-100 dark:bg-zinc-800",
      )}
    >
      <div className="mb-1 flex items-center justify-between">
        <span className="text-xs font-medium">
          <span className="text-muted-foreground mr-1 font-mono opacity-50">#{msg.id}</span>
          {roleLabels[msg.role] ?? msg.role}
          {msg.userName && ` (${msg.userName})`}
          {msg.role === "user" && msg.userId && (
            <span className="text-muted-foreground ml-1 font-mono text-[10px]">
              uid:{msg.userId}
            </span>
          )}
          {isToolCall && msg.meta && (
            <span className="ml-1 font-mono">{msg.meta.toolName as string}</span>
          )}
        </span>
        <div className="flex items-center gap-1.5">
          {onDelete && (
            <button
              type="button"
              className={cn(
                "rounded p-0.5 transition-colors",
                pendingDelete
                  ? "bg-red-500/15 text-red-600 opacity-100 dark:text-red-400"
                  : "text-muted-foreground hover:text-destructive opacity-0 group-hover/msg:opacity-100",
              )}
              onClick={() => onDelete(msg.id)}
              title={pendingDelete ? "再次点击确认删除" : "删除消息"}
            >
              <Trash2 className="h-3.5 w-3.5" />
            </button>
          )}
          <span className="text-xs opacity-60">{new Date(msg.createdAt).toLocaleString()}</span>
        </div>
      </div>

      {isToolCall ? (
        <ToolCallContent meta={msg.meta!} />
      ) : needsCollapse ? (
        <CollapsibleContent content={msg.content} />
      ) : (
        <p className="text-sm whitespace-pre-wrap">{msg.content}</p>
      )}

      {isAssistantWithMeta && <UsageBadge meta={msg.meta!} />}
    </div>
  );
}
