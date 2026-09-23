import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { BookOpen, Loader2, Pencil, Trash2 } from "lucide-react";
import { useTranslation } from "react-i18next";
import { CollapsibleContent } from "./collapsible-content";
import type { ConversationSummary } from "./types";

export function SummaryCard({
  summary,
  onDelete,
  pendingDelete,
  busy,
  disabled = false,
  editing = false,
  editDraft = "",
  editBusy = false,
  onStartEdit,
  onEditDraftChange,
  onSaveEdit,
  onCancelEdit,
}: {
  summary: ConversationSummary;
  onDelete: (id: number) => void;
  pendingDelete: boolean;
  busy: boolean;
  disabled?: boolean;
  editing?: boolean;
  editDraft?: string;
  editBusy?: boolean;
  onStartEdit?: (summary: ConversationSummary) => void;
  onEditDraftChange?: (value: string) => void;
  onSaveEdit?: () => void;
  onCancelEdit?: () => void;
}) {
  const { t, i18n } = useTranslation("bots");
  return (
    <article
      className={cn(
        "rounded-xl border bg-white p-3 shadow-[0_1px_2px_rgb(15_23_42/0.035)] sm:px-3.5",
        summary.isActive ? "border-emerald-200" : "border-slate-200/80",
      )}
    >
      <div className="flex items-start gap-2.5">
        <div className="flex size-7 shrink-0 items-center justify-center rounded-lg bg-amber-50 text-amber-600">
          <BookOpen className="size-3.5" aria-hidden="true" />
        </div>
        <div className="text-muted-foreground min-w-0 flex-1 text-xs tabular-nums">
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
            ) : (
              <span className="rounded-full bg-slate-100 px-2 py-0.5 text-[11px] font-medium text-slate-600">
                {t("conversations.historicalSummary")}
              </span>
            )}
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
        {summary.isActive && onStartEdit ? (
          <button
            type="button"
            disabled={disabled || editing || editBusy}
            onClick={() => onStartEdit(summary)}
            aria-label={t("conversations.editActiveSummary")}
            title={t("conversations.editActiveSummary")}
            className="text-muted-foreground hover:text-foreground focus-visible:ring-ring flex size-9 shrink-0 items-center justify-center rounded-lg hover:bg-slate-100 focus-visible:ring-2 focus-visible:outline-none disabled:pointer-events-none disabled:opacity-50"
          >
            <Pencil className="size-3.5" aria-hidden="true" />
          </button>
        ) : null}
        <button
          type="button"
          disabled={disabled || busy || summary.isActive}
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
            "text-muted-foreground hover:text-destructive focus-visible:ring-ring flex size-9 shrink-0 items-center justify-center rounded-lg transition-[background-color,color,scale] duration-150 ease-out focus-visible:ring-2 focus-visible:outline-none active:scale-[0.96] disabled:pointer-events-none disabled:opacity-50",
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
      <div className="mt-2 max-w-[80ch] text-sm leading-6 sm:pl-9">
        {editing ? (
          <div className="space-y-2.5">
            <label htmlFor={`summary-edit-${summary.id}`} className="block text-xs font-medium">
              {t("conversations.summaryEditLabel")}
            </label>
            <textarea
              id={`summary-edit-${summary.id}`}
              value={editDraft}
              maxLength={40_000}
              disabled={editBusy}
              onChange={(event) => onEditDraftChange?.(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Escape" && !editBusy) onCancelEdit?.();
              }}
              className="focus-visible:ring-ring min-h-40 w-full resize-y rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm leading-6 outline-none focus-visible:ring-2 disabled:opacity-60"
            />
            <p className="text-muted-foreground text-xs">{t("conversations.summaryEditHint")}</p>
            <div className="flex flex-wrap gap-2">
              <Button
                type="button"
                size="sm"
                disabled={editBusy || !editDraft.trim() || editDraft.trim() === summary.content}
                onClick={onSaveEdit}
              >
                {editBusy ? t("conversations.savingSummary") : t("conversations.saveSummary")}
              </Button>
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={editBusy}
                onClick={onCancelEdit}
              >
                {t("conversations.cancel")}
              </Button>
            </div>
          </div>
        ) : (
          <CollapsibleContent
            content={summary.content}
            characterThreshold={220}
            lineThreshold={2}
          />
        )}
      </div>
    </article>
  );
}
