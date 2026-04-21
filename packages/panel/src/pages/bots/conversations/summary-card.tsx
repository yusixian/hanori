import { cn } from "@/lib/utils";
import { Loader2, Trash2 } from "lucide-react";
import { CollapsibleContent } from "./collapsible-content";
import type { ConversationSummary } from "./types";

export function SummaryCard({
  summary,
  onDelete,
  pendingDelete,
  busy,
}: {
  summary: ConversationSummary;
  onDelete: (id: number) => void;
  pendingDelete: boolean;
  busy: boolean;
}) {
  return (
    <div className="rounded-md border p-3">
      <div className="mb-2 flex items-start justify-between gap-2">
        <div className="text-muted-foreground flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
          <span className="font-mono">#{summary.id}</span>
          <span>{new Date(summary.createdAt).toLocaleString()}</span>
          <span>压缩 {summary.messageCount} 条</span>
          <span className="font-mono opacity-70">up to msg #{summary.summarizedUpToId}</span>
        </div>
        <button
          type="button"
          disabled={busy}
          onClick={() => onDelete(summary.id)}
          title={pendingDelete ? "再次点击确认删除" : "删除"}
          className={cn(
            "shrink-0 rounded p-1 transition-colors",
            pendingDelete
              ? "bg-red-500/15 text-red-600 dark:text-red-400"
              : "text-muted-foreground hover:text-destructive",
          )}
        >
          {busy ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <Trash2 className="h-3.5 w-3.5" />
          )}
        </button>
      </div>
      <CollapsibleContent content={summary.content} />
    </div>
  );
}
