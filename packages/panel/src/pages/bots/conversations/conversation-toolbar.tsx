import { cn } from "@/lib/utils";
import { BookOpen, MessageSquare, Terminal, Wrench, type LucideIcon } from "lucide-react";
import type { KeyboardEvent } from "react";
import { useTranslation } from "react-i18next";

type DetailView = "messages" | "summaries";

function FilterToggle({
  label,
  icon: Icon,
  pressed,
  tone,
  onPressedChange,
}: {
  label: string;
  icon: LucideIcon;
  pressed: boolean;
  tone: "violet" | "amber";
  onPressedChange: () => void;
}) {
  const activeTone =
    tone === "violet"
      ? "bg-violet-50 text-violet-700 shadow-[inset_0_0_0_1px_rgb(124_58_237/0.12)]"
      : "bg-amber-50 text-amber-700 shadow-[inset_0_0_0_1px_rgb(217_119_6/0.14)]";

  return (
    <button
      type="button"
      aria-pressed={pressed}
      aria-label={label}
      onClick={onPressedChange}
      className={cn(
        "focus-visible:ring-ring inline-flex h-10 items-center gap-2 rounded-lg px-3 text-xs font-semibold transition-[background-color,box-shadow,color,scale] duration-150 ease-out focus-visible:ring-2 focus-visible:outline-none active:scale-[0.96]",
        pressed ? activeTone : "text-muted-foreground hover:bg-slate-100 hover:text-foreground",
      )}
    >
      <Icon className="size-3.5" aria-hidden="true" />
      {label}
      <span
        className={cn(
          "size-1.5 rounded-full transition-[background-color] duration-150",
          pressed ? (tone === "violet" ? "bg-violet-500" : "bg-amber-500") : "bg-slate-300",
        )}
        aria-hidden="true"
      />
    </button>
  );
}

export function ConversationToolbar({
  view,
  hasSummaries,
  summaryCount,
  showSystem,
  showTools,
  onViewChange,
  onToggleSystem,
  onToggleTools,
}: {
  view: DetailView;
  hasSummaries: boolean;
  summaryCount: number;
  showSystem: boolean;
  showTools: boolean;
  onViewChange: (view: DetailView) => void;
  onToggleSystem: () => void;
  onToggleTools: () => void;
}) {
  const { t } = useTranslation("bots");
  const handleTabKeyDown = (event: KeyboardEvent<HTMLButtonElement>, tab: DetailView) => {
    if (!hasSummaries) return;
    let nextView: DetailView | null = null;
    if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
      event.preventDefault();
      nextView = tab === "messages" ? "summaries" : "messages";
    } else if (event.key === "Home") {
      event.preventDefault();
      nextView = "messages";
    } else if (event.key === "End") {
      event.preventDefault();
      nextView = "summaries";
    }

    if (!nextView) return;
    onViewChange(nextView);
    requestAnimationFrame(() => document.getElementById(`conversation-${nextView}-tab`)?.focus());
  };

  return (
    <div className="flex shrink-0 flex-col gap-2 border-b border-slate-200/80 bg-white px-3 py-2.5 sm:flex-row sm:items-center sm:justify-between sm:px-4">
      <div
        role="tablist"
        aria-label={t("conversations.detailView")}
        className="grid w-full grid-cols-2 rounded-xl bg-slate-100 p-1 sm:w-auto"
      >
        <button
          id="conversation-messages-tab"
          type="button"
          role="tab"
          aria-selected={view === "messages"}
          aria-controls={view === "messages" ? "conversation-messages-panel" : undefined}
          tabIndex={view === "messages" ? 0 : -1}
          onClick={() => onViewChange("messages")}
          onKeyDown={(event) => handleTabKeyDown(event, "messages")}
          className={cn(
            "focus-visible:ring-ring inline-flex h-10 items-center justify-center gap-2 rounded-lg px-3 text-xs font-semibold transition-[background-color,box-shadow,color,scale] duration-150 ease-out focus-visible:ring-2 focus-visible:outline-none active:scale-[0.96]",
            view === "messages"
              ? "text-foreground bg-white shadow-[0_1px_2px_rgb(15_23_42/0.08),0_0_0_1px_rgb(15_23_42/0.04)]"
              : "text-muted-foreground hover:text-foreground",
          )}
        >
          <MessageSquare
            className={cn("size-3.5", view === "messages" && "text-primary")}
            aria-hidden="true"
          />
          {t("conversations.messages")}
        </button>
        <button
          id="conversation-summaries-tab"
          type="button"
          role="tab"
          aria-selected={view === "summaries"}
          aria-controls={view === "summaries" ? "conversation-summaries-panel" : undefined}
          tabIndex={view === "summaries" ? 0 : -1}
          disabled={!hasSummaries}
          onClick={() => onViewChange("summaries")}
          onKeyDown={(event) => handleTabKeyDown(event, "summaries")}
          className={cn(
            "focus-visible:ring-ring inline-flex h-10 items-center justify-center gap-2 rounded-lg px-3 text-xs font-semibold transition-[background-color,box-shadow,color,scale] duration-150 ease-out focus-visible:ring-2 focus-visible:outline-none active:scale-[0.96] disabled:pointer-events-none disabled:opacity-40",
            view === "summaries"
              ? "text-foreground bg-white shadow-[0_1px_2px_rgb(15_23_42/0.08),0_0_0_1px_rgb(15_23_42/0.04)]"
              : "text-muted-foreground hover:text-foreground",
          )}
          title={hasSummaries ? undefined : t("conversations.noSummaries")}
        >
          <BookOpen
            className={cn("size-3.5", view === "summaries" && "text-amber-600")}
            aria-hidden="true"
          />
          {t("conversations.summaries")}
          {hasSummaries ? (
            <span className="text-muted-foreground tabular-nums">{summaryCount}</span>
          ) : null}
        </button>
      </div>

      {view === "messages" ? (
        <div
          className="flex items-center justify-end gap-1"
          role="group"
          aria-label={t("conversations.messageFilters")}
        >
          <FilterToggle
            label={t("conversations.system")}
            icon={Terminal}
            pressed={showSystem}
            tone="violet"
            onPressedChange={onToggleSystem}
          />
          <FilterToggle
            label={t("conversations.tools")}
            icon={Wrench}
            pressed={showTools}
            tone="amber"
            onPressedChange={onToggleTools}
          />
        </div>
      ) : null}
    </div>
  );
}
