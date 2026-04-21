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
        "cursor-pointer rounded-md border p-3 transition-colors hover:bg-zinc-50 dark:hover:bg-zinc-800",
        selected && "border-blue-500 bg-blue-50 dark:bg-blue-900/20",
      )}
      onClick={onSelect}
    >
      <div className="mb-1.5 flex items-center gap-2">
        <MessageSquare className="text-muted-foreground h-4 w-4 shrink-0" />
        <span className="font-mono text-sm font-medium">{conv.chatId}</span>
        <ChatTypeBadge type={conv.chatType} />
        {conv.hasSummaries && (
          <Badge variant="muted">
            <BookOpen className="mr-0.5 h-3 w-3" />
            {conv.summaryCount}
          </Badge>
        )}
        <span className="flex-1" />
        <span className="text-muted-foreground shrink-0 text-xs">
          {new Date(conv.lastActive).toLocaleString()}
        </span>
        <Button
          variant="ghost"
          size="sm"
          className="h-6 w-6 shrink-0 p-0"
          onClick={(e) => {
            e.stopPropagation();
            onClear();
          }}
        >
          <Trash2 className="h-3.5 w-3.5 text-red-500" />
        </Button>
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
        <RoleDistributionBar roleCounts={conv.roleCounts} total={conv.messageCount} />
      </div>
    </div>
  );
}
