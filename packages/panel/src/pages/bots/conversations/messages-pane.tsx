import { Pagination } from "@/components/ui/pagination";
import { ArrowDown, ArrowUp, FilterX } from "lucide-react";
import { useCallback, useEffect, useRef, useState, type RefObject } from "react";
import { useTranslation } from "react-i18next";
import { MessageBubble } from "./message-bubble";
import type { ConversationMessage } from "./types";

function ScrollButtons({
  containerRef,
  canScrollUp,
  canScrollDown,
}: {
  containerRef: RefObject<HTMLDivElement | null>;
  canScrollUp: boolean;
  canScrollDown: boolean;
}) {
  const { t } = useTranslation("bots");
  if (!canScrollUp && !canScrollDown) return null;

  const scrollTo = (top: number) => {
    const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    containerRef.current?.scrollTo({ top, behavior: reduceMotion ? "auto" : "smooth" });
  };

  return (
    <div className="absolute right-3 bottom-3 flex flex-col gap-1.5">
      <button
        type="button"
        disabled={!canScrollUp}
        className="text-muted-foreground hover:text-foreground focus-visible:ring-ring flex size-10 items-center justify-center rounded-xl bg-white/95 shadow-[0_0_0_1px_rgb(15_23_42/0.07),0_4px_12px_rgb(15_23_42/0.09)] backdrop-blur transition-[color,opacity,scale] duration-150 ease-out focus-visible:ring-2 focus-visible:outline-none active:scale-[0.96] disabled:pointer-events-none disabled:opacity-35"
        onClick={() => scrollTo(0)}
        aria-label={t("conversations.scrollFirst")}
        title={t("conversations.scrollTop")}
      >
        <ArrowUp className="size-4" aria-hidden="true" />
      </button>
      <button
        type="button"
        disabled={!canScrollDown}
        className="text-muted-foreground hover:text-foreground focus-visible:ring-ring flex size-10 items-center justify-center rounded-xl bg-white/95 shadow-[0_0_0_1px_rgb(15_23_42/0.07),0_4px_12px_rgb(15_23_42/0.09)] backdrop-blur transition-[color,opacity,scale] duration-150 ease-out focus-visible:ring-2 focus-visible:outline-none active:scale-[0.96] disabled:pointer-events-none disabled:opacity-35"
        onClick={() => scrollTo(containerRef.current?.scrollHeight ?? 0)}
        aria-label={t("conversations.scrollLast")}
        title={t("conversations.scrollBottom")}
      >
        <ArrowDown className="size-4" aria-hidden="true" />
      </button>
    </div>
  );
}

export function MessagesPane({
  messages,
  showTools,
  showSystem,
  onDelete,
  pendingDeleteId,
  deleteBusyId,
  deleteDisabled = false,
  navigationDisabled = false,
  containerRef,
  page,
  totalPages,
  onPageChange,
}: {
  messages: ConversationMessage[];
  showTools: boolean;
  showSystem: boolean;
  onDelete: (id: number) => void;
  pendingDeleteId: number | null;
  deleteBusyId: number | null;
  deleteDisabled?: boolean;
  navigationDisabled?: boolean;
  containerRef: RefObject<HTMLDivElement | null>;
  page: number;
  totalPages: number;
  onPageChange: (p: number) => void;
}) {
  const { t } = useTranslation("bots");
  const listRef = useRef<HTMLOListElement>(null);
  const scrollFrameRef = useRef<number | null>(null);
  const [scrollEdges, setScrollEdges] = useState({ up: false, down: false });
  const visibleMessages = messages.filter(
    (message) =>
      (showTools || (message.role !== "tool_call" && message.role !== "tool_result")) &&
      (showSystem || message.role !== "system"),
  );

  const updateScrollEdges = useCallback(() => {
    const element = containerRef.current;
    if (!element) return;
    const maxScrollTop = Math.max(0, element.scrollHeight - element.clientHeight);
    const nextEdges = {
      up: element.scrollTop > 8,
      down: maxScrollTop - element.scrollTop > 8,
    };
    setScrollEdges((current) => {
      if (current.up === nextEdges.up && current.down === nextEdges.down) return current;
      return nextEdges;
    });
  }, [containerRef]);

  const scheduleScrollEdgeUpdate = useCallback(() => {
    if (scrollFrameRef.current !== null) return;
    scrollFrameRef.current = requestAnimationFrame(() => {
      scrollFrameRef.current = null;
      updateScrollEdges();
    });
  }, [updateScrollEdges]);

  useEffect(() => {
    const element = containerRef.current;
    if (!element) return;

    scheduleScrollEdgeUpdate();
    element.addEventListener("scroll", scheduleScrollEdgeUpdate, { passive: true });
    const observer = new ResizeObserver(scheduleScrollEdgeUpdate);
    observer.observe(element);
    if (listRef.current) observer.observe(listRef.current);

    return () => {
      if (scrollFrameRef.current !== null) cancelAnimationFrame(scrollFrameRef.current);
      scrollFrameRef.current = null;
      element.removeEventListener("scroll", scheduleScrollEdgeUpdate);
      observer.disconnect();
    };
  }, [containerRef, scheduleScrollEdgeUpdate, visibleMessages.length]);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="relative min-h-0 flex-1 overflow-hidden">
        <div
          ref={containerRef}
          className="h-full overflow-y-auto overscroll-contain bg-slate-50/70 p-3 pb-16 sm:p-4 sm:pb-16"
        >
          {visibleMessages.length === 0 ? (
            <div className="text-muted-foreground flex h-full min-h-56 flex-col items-center justify-center px-6 text-center">
              <span className="flex size-11 items-center justify-center rounded-xl bg-slate-100">
                <FilterX className="size-5" aria-hidden="true" />
              </span>
              <p className="text-foreground mt-3 text-sm font-semibold">
                {t("conversations.noVisibleMessages")}
              </p>
              <p className="mt-1 max-w-xs text-xs leading-5">
                {t("conversations.filteredMessagesDescription")}
              </p>
            </div>
          ) : (
            <ol
              ref={listRef}
              className="divide-y divide-slate-100 overflow-hidden rounded-xl bg-white shadow-[0_0_0_1px_rgb(15_23_42/0.055),0_1px_2px_rgb(15_23_42/0.04)]"
              aria-label={t("conversations.messageListLabel")}
            >
              {visibleMessages.map((message) => (
                <li
                  key={message.id}
                  className="[contain-intrinsic-size:auto_8rem] [content-visibility:auto]"
                >
                  <MessageBubble
                    msg={message}
                    onDelete={onDelete}
                    pendingDelete={pendingDeleteId === message.id}
                    deleteBusy={deleteBusyId === message.id}
                    deleteDisabled={deleteDisabled}
                  />
                </li>
              ))}
            </ol>
          )}
        </div>

        <ScrollButtons
          containerRef={containerRef}
          canScrollUp={scrollEdges.up}
          canScrollDown={scrollEdges.down}
        />
      </div>

      <Pagination
        page={page}
        totalPages={totalPages}
        disabled={navigationDisabled}
        onPageChange={onPageChange}
        className="flex shrink-0 items-center justify-center gap-2 border-t border-slate-200/80 bg-white px-3 py-2"
      />
    </div>
  );
}
