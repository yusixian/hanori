import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { BookOpen, MessageSquare, Trash2, Users } from "lucide-react";
import { ChatTypeBadge, RoleDistributionBar } from "./conversation-detail-header";
import { roleLabels } from "./constants";
import type { ConversationItem } from "./types";

function UserNamesList({ names }: { names: string[] | null }) {
  if (!names?.length) return null;
  const show = names.slice(0, 3);
  const rest = names.length - show.length;
  return (
    <div className="text-muted-foreground flex items-center gap-1 text-xs">
      <Users className="h-3 w-3 shrink-0" />
      <span className="truncate">
        {show.join(", ")}
        {rest > 0 && ` +${rest} more`}
      </span>
    </div>
  );
}

function MessagePreview({ lastMessage }: { lastMessage: ConversationItem["lastMessage"] }) {
  if (!lastMessage) return null;

  const prefix = roleLabels[lastMessage.role] ?? lastMessage.role;
  const name = lastMessage.userName ? ` (${lastMessage.userName})` : "";
  const text =
    lastMessage.content.length > 120
      ? `${lastMessage.content.slice(0, 120)}...`
      : lastMessage.content;

  return (
    <p className="text-muted-foreground line-clamp-2 text-xs">
      <span className="font-medium">
        {prefix}
        {name}:
      </span>{" "}
      {text}
    </p>
  );
}

export function ConversationListItem({
  conv,
  selected,
  onSelect,
  onClear,
}: {
  conv: ConversationItem;
  selected: boolean;
  onSelect: () => void;
  onClear: () => void;
}) {
  return (
    <div
      className={cn(
        "group relative cursor-pointer overflow-hidden rounded-xl p-3 ring-1 ring-border/70 transition-[background-color,box-shadow] hover:bg-muted/50 hover:ring-border",
        selected && "bg-blue-50/70 ring-2 ring-blue-500/70 dark:bg-blue-950/30",
      )}
      onClick={onSelect}
    >
      <div className="mb-1.5 flex min-w-0 items-center gap-2">
        <MessageSquare className="text-muted-foreground h-4 w-4 shrink-0" />
        <span className="min-w-0 truncate font-mono text-sm font-medium tabular-nums">
          {conv.chatId}
        </span>
        <ChatTypeBadge type={conv.chatType} />
        {conv.hasSummaries && (
          <Badge variant="muted">
            <BookOpen className="mr-0.5 h-3 w-3" />
            {conv.summaryCount}
          </Badge>
        )}
        <span className="flex-1" />
        <Button
          variant="ghost"
          size="sm"
          className="text-muted-foreground -mr-2 size-10 shrink-0 p-0 opacity-100 hover:text-red-600 sm:opacity-0 sm:group-hover:opacity-100 sm:focus-visible:opacity-100"
          onClick={(e) => {
            e.stopPropagation();
            onClear();
          }}
        >
          <Trash2 className="h-3.5 w-3.5 text-red-500" />
        </Button>
      </div>

      <div className="text-muted-foreground mb-1.5 truncate text-xs tabular-nums">
        {new Date(conv.lastActive).toLocaleString()}
      </div>

      <UserNamesList names={conv.userNames} />

      {conv.lastMessage && (
        <div className="mt-1">
          <MessagePreview lastMessage={conv.lastMessage} />
        </div>
      )}

      <div className="mt-2 space-y-1.5">
        <div className="text-muted-foreground flex items-center gap-3 text-xs">
          <span>{conv.messageCount} msgs</span>
          <span>{conv.distinctUserCount} users</span>
        </div>
        <div className="hidden sm:block">
          <RoleDistributionBar roleCounts={conv.roleCounts} total={conv.messageCount} />
        </div>
      </div>
    </div>
  );
}
