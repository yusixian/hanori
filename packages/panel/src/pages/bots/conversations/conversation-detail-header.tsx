import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { MessageSquare, User, Users } from "lucide-react";
import type { ConversationItem } from "./types";

export function getConversationTitle(conv: ConversationItem) {
  if (!conv.userNames?.length) {
    return conv.chatType === "group" ? "Group conversation" : "Private conversation";
  }

  const visibleNames = conv.userNames.slice(0, 2);
  const remaining = conv.userNames.length - visibleNames.length;
  return `${visibleNames.join(", ")}${remaining > 0 ? ` +${remaining}` : ""}`;
}

export function ChatTypeBadge({
  type,
  className,
}: {
  type: "private" | "group";
  className?: string;
}) {
  return (
    <Badge
      variant="muted"
      className={cn(
        "border-0 bg-slate-100 px-2 py-1 text-slate-600 shadow-[inset_0_0_0_1px_rgb(15_23_42/0.04)]",
        className,
      )}
    >
      {type === "private" ? (
        <>
          <User className="mr-1 size-3" aria-hidden="true" /> Private
        </>
      ) : (
        <>
          <Users className="mr-1 size-3" aria-hidden="true" /> Group
        </>
      )}
    </Badge>
  );
}

export function ConversationDetailHeader({ conv }: { conv: ConversationItem }) {
  const title = getConversationTitle(conv);

  return (
    <div className="flex min-w-0 flex-1 items-start gap-3">
      <div className="bg-accent text-primary hidden size-10 shrink-0 items-center justify-center rounded-xl sm:flex">
        <MessageSquare className="size-[18px]" aria-hidden="true" />
      </div>

      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 flex-nowrap items-center gap-2">
          <h2 className="min-w-0 flex-1 truncate text-base font-semibold tracking-tight sm:text-lg">
            {title}
          </h2>
          <ChatTypeBadge type={conv.chatType} className="hidden shrink-0 sm:inline-flex" />
        </div>

        <div className="text-muted-foreground mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs tabular-nums xl:flex-nowrap xl:overflow-hidden">
          <span className="max-w-48 truncate font-mono" title={String(conv.chatId)}>
            {conv.chatId}
          </span>
          <span aria-hidden="true">·</span>
          <span>{conv.messageCount} messages</span>
          <span aria-hidden="true">·</span>
          <span>{conv.distinctUserCount} users</span>
          <span aria-hidden="true">·</span>
          <span className="min-w-0 truncate">
            {new Date(conv.firstActive).toLocaleDateString()} —{" "}
            {new Date(conv.lastActive).toLocaleDateString()}
          </span>
        </div>
      </div>
    </div>
  );
}
