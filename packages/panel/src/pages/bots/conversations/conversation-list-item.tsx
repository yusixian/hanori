import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { BookOpen, MessageSquare, Trash2, Users } from "lucide-react";
import { useTranslation } from "react-i18next";
import { ChatTypeBadge, getConversationTitle } from "./conversation-detail-header";
import { roleLabelKeys } from "./constants";
import type { ConversationItem } from "./types";

function MessagePreview({ lastMessage }: { lastMessage: ConversationItem["lastMessage"] }) {
  const { t } = useTranslation("bots");
  if (!lastMessage) return null;

  const prefix = t(roleLabelKeys[lastMessage.role] ?? lastMessage.role);
  const name = lastMessage.userName ? ` (${lastMessage.userName})` : "";

  return (
    <p className="text-muted-foreground mt-2 line-clamp-2 text-xs leading-5 break-words">
      <span className="text-foreground/75 font-medium">
        {prefix}
        {name}:
      </span>{" "}
      {lastMessage.content}
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
  const { t, i18n } = useTranslation("bots");
  const title = getConversationTitle(conv, t);

  return (
    <li data-hover-actions className="group relative min-w-0">
      <button
        type="button"
        data-conversation-id={conv.chatId}
        aria-current={selected ? "true" : undefined}
        onClick={onSelect}
        className={cn(
          "focus-visible:ring-ring relative w-full min-w-0 rounded-xl px-3 py-3 pr-12 text-left transition-[background-color,box-shadow] duration-150 ease-out focus-visible:ring-2 focus-visible:ring-inset focus-visible:outline-none",
          selected
            ? "bg-accent shadow-[inset_3px_0_0_#2563eb]"
            : "hover:bg-slate-50 active:bg-slate-100",
        )}
      >
        <div className="flex min-w-0 items-center gap-2">
          <MessageSquare
            className={cn("size-4 shrink-0", selected ? "text-primary" : "text-muted-foreground")}
            aria-hidden="true"
          />
          <span className="min-w-0 truncate text-sm font-semibold" title={title}>
            {title}
          </span>
          <ChatTypeBadge type={conv.chatType} />
        </div>

        <div className="text-muted-foreground mt-1.5 flex min-w-0 items-center gap-2 text-[11px] tabular-nums">
          <span className="min-w-0 truncate font-mono" title={String(conv.chatId)}>
            {conv.chatId}
          </span>
          <span aria-hidden="true">·</span>
          <time className="shrink-0" dateTime={new Date(conv.lastActive).toISOString()}>
            {new Date(conv.lastActive).toLocaleString(i18n.resolvedLanguage)}
          </time>
        </div>

        <MessagePreview lastMessage={conv.lastMessage} />

        <div className="text-muted-foreground mt-2.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs tabular-nums">
          <span>{t("conversations.messageCount", { count: conv.messageCount })}</span>
          <span className="inline-flex items-center gap-1">
            <Users className="size-3" aria-hidden="true" />
            {conv.distinctUserCount}
          </span>
          {conv.hasSummaries ? (
            <span className="inline-flex items-center gap-1">
              <BookOpen className="size-3" aria-hidden="true" />
              {conv.summaryCount}
            </span>
          ) : null}
        </div>
      </button>

      <Button
        variant="ghost"
        size="icon"
        className="hover-action text-muted-foreground hover:text-destructive absolute top-1.5 right-1.5 size-10 shrink-0 transition-[background-color,color,opacity,scale] active:scale-[0.96]"
        onClick={onClear}
        aria-label={t("conversations.deleteConversationLabel", { chatId: conv.chatId })}
        title={t("conversations.deleteConversation")}
      >
        <Trash2 className="size-3.5" aria-hidden="true" />
      </Button>
    </li>
  );
}
