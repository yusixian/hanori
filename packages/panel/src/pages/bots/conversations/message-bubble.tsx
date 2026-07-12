import { CodeBlock } from "@/components/ui/code-block";
import { cn } from "@/lib/utils";
import {
  Braces,
  FileText,
  Loader2,
  Sparkles,
  Terminal,
  Trash2,
  UserRound,
  Wrench,
  type LucideIcon,
} from "lucide-react";
import { useId, useMemo, useState } from "react";
import { CollapsibleContent } from "./collapsible-content";
import { roleIconStyles, roleLabels } from "./constants";
import { DisclosureIcon } from "./disclosure-icon";
import type { ConversationMessage } from "./types";

const roleIcons: Record<string, LucideIcon> = {
  user: UserRound,
  assistant: Sparkles,
  context: FileText,
  system: Terminal,
  tool_call: Wrench,
  tool_result: Braces,
};

function UsageBadge({ meta }: { meta: Record<string, unknown> }) {
  const usage = meta.usage as Record<string, number> | undefined;
  const model = meta.model as string | undefined;
  const trigger = meta.trigger as string | undefined;
  const promptTokens = usage?.prompt_tokens;
  const completionTokens = usage?.completion_tokens;
  const totalTokens = usage?.total_tokens;
  const hasFullBreakdown =
    Number.isFinite(promptTokens) &&
    Number.isFinite(completionTokens) &&
    Number.isFinite(totalTokens);
  const tokenLabel = hasFullBreakdown
    ? `${promptTokens}+${completionTokens}=${totalTokens} tokens`
    : Number.isFinite(totalTokens)
      ? `${totalTokens} tokens`
      : null;

  if (!usage && !model) return null;

  return (
    <div className="mt-3 flex flex-wrap gap-1.5">
      {model ? (
        <span className="rounded-md bg-slate-100 px-2 py-1 font-mono text-[10px] text-slate-600">
          {model}
        </span>
      ) : null}
      {trigger ? (
        <span className="rounded-md bg-slate-100 px-2 py-1 text-[10px] text-slate-600">
          trigger: {trigger}
        </span>
      ) : null}
      {tokenLabel ? (
        <span className="rounded-md bg-slate-100 px-2 py-1 font-mono text-[10px] text-slate-600 tabular-nums">
          {tokenLabel}
        </span>
      ) : null}
    </div>
  );
}

function ToolCallContent({ meta }: { meta: Record<string, unknown> }) {
  const [expanded, setExpanded] = useState(false);
  const argsId = useId();
  const toolName = meta.toolName as string;
  const args = meta.args as string | undefined;
  const parsedArgs = useMemo(() => {
    if (!args || !expanded) return undefined;
    try {
      return JSON.stringify(JSON.parse(args), null, 2);
    } catch {
      return args;
    }
  }, [args, expanded]);

  return (
    <div>
      <p className="font-mono text-sm font-semibold">{toolName}()</p>
      {args ? (
        <>
          <button
            type="button"
            aria-expanded={expanded}
            aria-controls={argsId}
            className="text-muted-foreground hover:text-foreground focus-visible:ring-ring mt-1.5 inline-flex min-h-10 items-center gap-1.5 rounded-lg px-2 text-xs font-medium transition-[background-color,color,scale] duration-150 ease-out hover:bg-slate-100 focus-visible:ring-2 focus-visible:outline-none active:scale-[0.96]"
            onClick={() => setExpanded((value) => !value)}
          >
            <DisclosureIcon expanded={expanded} />
            {expanded ? "Hide arguments" : "Show arguments"}
          </button>
          {expanded ? (
            <CodeBlock id={argsId} className="mt-1 max-h-60 text-xs">
              {parsedArgs}
            </CodeBlock>
          ) : null}
        </>
      ) : null}
    </div>
  );
}

export function MessageBubble({
  msg,
  onDelete,
  pendingDelete,
  deleteBusy,
}: {
  msg: ConversationMessage;
  onDelete?: (messageId: number) => void;
  pendingDelete?: boolean;
  deleteBusy?: boolean;
}) {
  const isToolCall = msg.role === "tool_call" && msg.meta;
  const isAssistantWithMeta = msg.role === "assistant" && msg.meta;
  const needsCollapse =
    msg.role === "system" || msg.role === "tool_result" || msg.role === "context";
  const RoleIcon = roleIcons[msg.role] ?? FileText;

  return (
    <article data-hover-actions className="group/msg text-foreground min-w-0 p-3.5 sm:p-4">
      <div className="flex min-w-0 flex-wrap items-start gap-2.5">
        <div
          className={cn(
            "flex size-8 shrink-0 items-center justify-center rounded-lg",
            roleIconStyles[msg.role] ?? "bg-slate-100 text-slate-500",
          )}
        >
          <RoleIcon className="size-3.5" aria-hidden="true" />
        </div>

        <div className="min-w-0 flex-1 pt-0.5">
          <div className="flex min-w-0 flex-wrap items-baseline gap-x-1.5 gap-y-0.5">
            <span className="text-xs font-semibold">{roleLabels[msg.role] ?? msg.role}</span>
            {msg.userName ? (
              <span className="min-w-0 truncate text-xs font-medium">{msg.userName}</span>
            ) : null}
            {isToolCall && msg.meta ? (
              <span className="min-w-0 truncate font-mono text-xs">
                {msg.meta.toolName as string}
              </span>
            ) : null}
          </div>
          <div className="text-muted-foreground mt-0.5 flex flex-wrap gap-x-2 text-[10px] tabular-nums">
            <span className="font-mono">#{msg.id}</span>
            {msg.role === "user" && msg.userId ? (
              <span className="font-mono">uid:{msg.userId}</span>
            ) : null}
          </div>
        </div>

        <div className="ml-auto flex items-center gap-1">
          <time
            className="text-muted-foreground text-[11px] whitespace-nowrap tabular-nums"
            dateTime={new Date(msg.createdAt).toISOString()}
          >
            {new Date(msg.createdAt).toLocaleString()}
          </time>
          {onDelete ? (
            <button
              type="button"
              disabled={deleteBusy}
              data-active={pendingDelete || deleteBusy ? "true" : undefined}
              className={cn(
                "hover-action focus-visible:ring-ring flex size-10 items-center justify-center rounded-lg transition-[background-color,color,opacity,scale] duration-150 ease-out focus-visible:ring-2 focus-visible:outline-none active:scale-[0.96] disabled:pointer-events-none",
                pendingDelete
                  ? "bg-red-50 text-red-600 opacity-100"
                  : "text-muted-foreground hover:bg-red-50 hover:text-destructive",
              )}
              onClick={() => onDelete(msg.id)}
              aria-label={
                deleteBusy
                  ? "Deleting this message"
                  : pendingDelete
                    ? "Confirm deleting this message"
                    : "Delete this message"
              }
              title={pendingDelete ? "Click again to confirm" : "Delete message"}
            >
              {deleteBusy ? (
                <Loader2 className="size-3.5 animate-spin" aria-hidden="true" />
              ) : (
                <Trash2 className="size-3.5" aria-hidden="true" />
              )}
            </button>
          ) : null}
        </div>
      </div>

      <div className="mt-3 max-w-[80ch] text-sm leading-6 sm:pl-10">
        {isToolCall ? (
          <ToolCallContent meta={msg.meta!} />
        ) : needsCollapse ? (
          <CollapsibleContent content={msg.content} />
        ) : (
          <p className="break-words whitespace-pre-wrap">{msg.content}</p>
        )}

        {isAssistantWithMeta ? <UsageBadge meta={msg.meta!} /> : null}
      </div>
    </article>
  );
}
