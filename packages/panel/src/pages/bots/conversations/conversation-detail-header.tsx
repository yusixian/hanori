import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { BookOpen, User, Users } from "lucide-react";
import { roleColors, roleLabels } from "./constants";
import type { ConversationItem } from "./types";

export function ChatTypeBadge({ type }: { type: "private" | "group" }) {
  return (
    <Badge variant={type === "private" ? "default" : "warning"}>
      {type === "private" ? (
        <>
          <User className="mr-1 h-3 w-3" /> Private
        </>
      ) : (
        <>
          <Users className="mr-1 h-3 w-3" /> Group
        </>
      )}
    </Badge>
  );
}

export function RoleDistributionBar({
  roleCounts,
  total,
}: {
  roleCounts: ConversationItem["roleCounts"];
  total: number;
}) {
  if (total === 0) return null;

  const segments: Array<{ key: string; count: number; color: string }> = [
    { key: "user", count: roleCounts.user, color: roleColors.user! },
    { key: "assistant", count: roleCounts.assistant, color: roleColors.assistant! },
    { key: "tool_call", count: roleCounts.tool_call, color: roleColors.tool_call! },
    { key: "tool_result", count: roleCounts.tool_result, color: roleColors.tool_result! },
    { key: "system", count: roleCounts.system, color: roleColors.system! },
    { key: "context", count: roleCounts.context, color: roleColors.context! },
  ].filter((s) => s.count > 0);

  return (
    <div className="flex h-1.5 w-full overflow-hidden rounded-full bg-zinc-200 dark:bg-zinc-700">
      {segments.map((seg) => (
        <div
          key={seg.key}
          className={cn("h-full", seg.color)}
          style={{ width: `${(seg.count / total) * 100}%` }}
          title={`${roleLabels[seg.key] ?? seg.key}: ${seg.count}`}
        />
      ))}
    </div>
  );
}

export function ConversationDetailHeader({
  conv,
  onOpenSummaries,
}: {
  conv: ConversationItem;
  onOpenSummaries?: () => void;
}) {
  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2">
        <span className="font-mono text-base font-bold">{conv.chatId}</span>
        <ChatTypeBadge type={conv.chatType} />
        {conv.hasSummaries &&
          (onOpenSummaries ? (
            <button
              type="button"
              onClick={onOpenSummaries}
              title="查看压缩摘要"
              className="rounded focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500"
            >
              <Badge
                variant="muted"
                className="cursor-pointer hover:bg-zinc-200 dark:hover:bg-zinc-700"
              >
                <BookOpen className="mr-1 h-3 w-3" />
                {conv.summaryCount} summaries
              </Badge>
            </button>
          ) : (
            <Badge variant="muted">
              <BookOpen className="mr-1 h-3 w-3" />
              {conv.summaryCount} summaries
            </Badge>
          ))}
      </div>
      <div className="text-muted-foreground flex flex-wrap gap-x-4 gap-y-1 text-xs">
        <span>{conv.messageCount} messages</span>
        <span>{conv.distinctUserCount} users</span>
        <span>
          {new Date(conv.firstActive).toLocaleDateString()} —{" "}
          {new Date(conv.lastActive).toLocaleDateString()}
        </span>
      </div>
      <RoleDistributionBar roleCounts={conv.roleCounts} total={conv.messageCount} />
    </div>
  );
}
