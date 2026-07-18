import { cn } from "@/lib/utils";
import { BookOpen, Loader2, Trash2 } from "lucide-react";
import { useTranslation } from "react-i18next";
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
  const { t, i18n } = useTranslation("bots");
  return (
    <article className="rounded-xl bg-white p-4 shadow-[0_0_0_1px_rgb(15_23_42/0.055),0_1px_2px_rgb(15_23_42/0.04)]">
      <div className="mb-3 flex items-start gap-2.5">
        <div className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-amber-50 text-amber-600">
          <BookOpen className="size-3.5" aria-hidden="true" />
        </div>
        <div className="text-muted-foreground min-w-0 flex-1 pt-0.5 text-xs tabular-nums">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-foreground font-semibold">
              {t("conversations.summaryNumber", { id: summary.id })}
            </span>
            {summary.isActive ? (
              <span
                className="rounded-full bg-emerald-50 px-2 py-0.5 text-[11px] font-medium text-emerald-700"
                title={t("conversations.activeSummaryDescription")}
              >
                {t("conversations.activeSummary")}
              </span>
            ) : null}
          </div>
          <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1">
            <time dateTime={new Date(summary.createdAt).toISOString()}>
              {new Date(summary.createdAt).toLocaleString(i18n.resolvedLanguage)}
            </time>
            <span aria-hidden="true">·</span>
            <span>{t("conversations.messagesCompressed", { count: summary.messageCount })}</span>
            <span aria-hidden="true">·</span>
            <span className="font-mono">
              {t("conversations.throughMessage", { id: summary.summarizedUpToId })}
            </span>
          </div>
        </div>
        <button
          type="button"
          disabled={busy || summary.isActive}
          onClick={() => onDelete(summary.id)}
          aria-label={
            summary.isActive
              ? t("conversations.activeSummaryDeleteBlocked")
              : pendingDelete
                ? t("conversations.confirmDeleteSummary")
                : t("conversations.deleteSummary")
          }
          title={
            summary.isActive
              ? t("conversations.activeSummaryDeleteBlocked")
              : pendingDelete
                ? t("conversations.clickAgainToDelete")
                : t("conversations.deleteSummary")
          }
          className={cn(
            "text-muted-foreground hover:text-destructive focus-visible:ring-ring flex size-10 shrink-0 items-center justify-center rounded-lg transition-[background-color,color,scale] duration-150 ease-out focus-visible:ring-2 focus-visible:outline-none active:scale-[0.96] disabled:pointer-events-none disabled:opacity-50",
            pendingDelete && "bg-red-50 text-red-600",
          )}
        >
          {busy ? (
            <Loader2 className="size-3.5 animate-spin" aria-hidden="true" />
          ) : (
            <Trash2 className="size-3.5" aria-hidden="true" />
          )}
        </button>
      </div>
      <div className="max-w-[80ch] pl-0 text-sm leading-6 sm:pl-10">
        <CollapsibleContent content={summary.content} />
      </div>
    </article>
  );
}
