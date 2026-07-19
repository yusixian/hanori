import { Button } from "@/components/ui/button";
import { Pagination } from "@/components/ui/pagination";
import { client } from "@/lib/client";
import { cn } from "@/lib/utils";
import { ArrowLeft, Inbox, Loader2, MessageSquareText, Trash2 } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useParams } from "react-router";
import { toast } from "sonner";
import { PENDING_DELETE_MS } from "./constants";
import { ConversationDetailHeader } from "./conversation-detail-header";
import { ConversationListItem } from "./conversation-list-item";
import { ConversationToolbar } from "./conversation-toolbar";
import { MessagesPane } from "./messages-pane";
import { SummaryCard } from "./summary-card";
import type { ConversationItem, ConversationMessage, ConversationSummary } from "./types";

function PaneLoading({ label }: { label: string }) {
  return (
    <div
      className="text-muted-foreground flex min-h-56 flex-1 items-center justify-center gap-2 text-sm"
      role="status"
      aria-live="polite"
    >
      <Loader2 className="size-4 animate-spin" aria-hidden="true" />
      <span>{label}</span>
    </div>
  );
}

export function BotConversationsPage() {
  const { t } = useTranslation("bots");
  const { botId } = useParams<{ botId: string }>();
  const [conversations, setConversations] = useState<ConversationItem[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true);
  const [selectedChat, setSelectedChat] = useState<number | null>(null);
  const [messages, setMessages] = useState<ConversationMessage[]>([]);
  const [msgTotal, setMsgTotal] = useState(0);
  const [msgPage, setMsgPage] = useState(1);
  const [msgLoading, setMsgLoading] = useState(false);
  const [showTools, setShowTools] = useState(false);
  const [showSystem, setShowSystem] = useState(false);
  const [detailView, setDetailView] = useState<"messages" | "summaries">("messages");
  const [summaries, setSummaries] = useState<ConversationSummary[]>([]);
  const [sumTotal, setSumTotal] = useState(0);
  const [sumPage, setSumPage] = useState(1);
  const [sumLoading, setSumLoading] = useState(false);
  const [sumPendingDelete, setSumPendingDelete] = useState<number | null>(null);
  const [sumDeleteBusy, setSumDeleteBusy] = useState<number | null>(null);
  const [msgPendingDelete, setMsgPendingDelete] = useState<number | null>(null);
  const [msgDeleteBusy, setMsgDeleteBusy] = useState<number | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<{
    kind: "all" | "chat";
    chatId?: number;
  } | null>(null);
  const [confirmDeleteBusy, setConfirmDeleteBusy] = useState(false);
  const [confirmDeleteError, setConfirmDeleteError] = useState<string | null>(null);

  const msgContainerRef = useRef<HTMLDivElement>(null);
  const msgReqToken = useRef(0);
  const sumReqToken = useRef(0);
  const msgPendingTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const sumPendingTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const deleteDialogRef = useRef<HTMLDivElement>(null);
  const cancelDeleteButtonRef = useRef<HTMLButtonElement>(null);
  const conversationListHeadingRef = useRef<HTMLHeadingElement>(null);
  const backButtonRef = useRef<HTMLButtonElement>(null);
  const skipDialogFocusRestoreRef = useRef(false);
  const confirmDeleteBusyRef = useRef(false);

  const limit = 20;
  const msgLimit = 50;
  const sumLimit = 20;

  const resetConversationDetail = useCallback((chatId: number | null) => {
    msgReqToken.current += 1;
    sumReqToken.current += 1;
    setSelectedChat(chatId);
    setMessages([]);
    setMsgTotal(0);
    setSummaries([]);
    setSumTotal(0);
    setMsgPage(1);
    setSumPage(1);
    setDetailView("messages");
    setMsgLoading(chatId !== null);
    setSumLoading(false);
    setMsgPendingDelete(null);
    setSumPendingDelete(null);
    setMsgDeleteBusy(null);
    setSumDeleteBusy(null);
  }, []);

  const focusConversationList = useCallback((chatId?: number) => {
    requestAnimationFrame(() => {
      const row =
        chatId === undefined
          ? null
          : document.querySelector<HTMLButtonElement>(`[data-conversation-id="${chatId}"]`);
      (row ?? conversationListHeadingRef.current)?.focus();
    });
  }, []);

  useEffect(
    () => () => {
      if (msgPendingTimer.current) clearTimeout(msgPendingTimer.current);
      if (sumPendingTimer.current) clearTimeout(sumPendingTimer.current);
    },
    [],
  );

  useEffect(() => {
    if (!confirmDelete) return;

    const previouslyFocused =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const frame = requestAnimationFrame(() => cancelDeleteButtonRef.current?.focus());

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        if (confirmDeleteBusyRef.current) return;
        setConfirmDelete(null);
        return;
      }

      if (event.key !== "Tab" || !deleteDialogRef.current) return;
      const focusable = Array.from(
        deleteDialogRef.current.querySelectorAll<HTMLElement>(
          'button:not([disabled]), [href], input:not([disabled]), [tabindex]:not([tabindex="-1"])',
        ),
      );
      const first = focusable[0];
      const last = focusable.at(-1);
      if (!first || !last) return;

      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };

    document.addEventListener("keydown", handleKeyDown);
    return () => {
      cancelAnimationFrame(frame);
      document.removeEventListener("keydown", handleKeyDown);
      if (skipDialogFocusRestoreRef.current) skipDialogFocusRestoreRef.current = false;
      else if (previouslyFocused?.isConnected) previouslyFocused.focus();
    };
  }, [confirmDelete]);

  const loadConversations = useCallback(
    async (silent = false) => {
      if (!botId) return;
      if (!silent) setLoading(true);
      try {
        const res = await client.api.bots[":botId"].conversations.$get({
          param: { botId },
          query: { page: String(page), limit: String(limit) },
        });
        const json = await res.json();
        if (json.ok) {
          setConversations(json.data);
          setTotal(json.total);
        }
      } catch (err) {
        console.error("Failed to load conversations:", err);
      } finally {
        if (!silent) setLoading(false);
      }
    },
    [botId, page],
  );

  const loadMessages = useCallback(async () => {
    if (!botId || selectedChat === null) return;
    const token = ++msgReqToken.current;
    setMsgLoading(true);
    try {
      const res = await client.api.bots[":botId"].conversations[":chatId"].$get({
        param: { botId, chatId: String(selectedChat) },
        query: { page: String(msgPage), limit: String(msgLimit) },
      });
      const json = await res.json();
      if (token !== msgReqToken.current) return;
      if (json.ok) {
        setMessages(json.data);
        setMsgTotal(json.total);
      }
    } catch (err) {
      console.error("Failed to load messages:", err);
    } finally {
      if (token === msgReqToken.current) {
        setMsgLoading(false);
        msgContainerRef.current?.scrollTo({ top: 0 });
      }
    }
  }, [botId, selectedChat, msgPage]);

  const loadSummaries = useCallback(async () => {
    if (!botId || selectedChat === null) return;
    const token = ++sumReqToken.current;
    setSumLoading(true);
    try {
      const res = await client.api.bots[":botId"].conversations[":chatId"].summaries.$get({
        param: { botId, chatId: String(selectedChat) },
        query: { page: String(sumPage), limit: String(sumLimit) },
      });
      const json = await res.json();
      if (token !== sumReqToken.current) return;
      if (json.ok) {
        setSummaries(json.data);
        setSumTotal(json.total);
      }
    } catch (err) {
      console.error("Failed to load summaries:", err);
    } finally {
      if (token === sumReqToken.current) setSumLoading(false);
    }
  }, [botId, selectedChat, sumPage]);

  useEffect(() => {
    loadConversations();
  }, [loadConversations]);

  useEffect(() => {
    if (selectedChat !== null && detailView === "messages") {
      loadMessages();
    }
  }, [loadMessages, selectedChat, detailView]);

  useEffect(() => {
    if (selectedChat !== null && detailView === "summaries") {
      loadSummaries();
    }
  }, [loadSummaries, selectedChat, detailView]);

  useEffect(() => {
    setDetailView("messages");
    setSumPage(1);
    setSumPendingDelete(null);
    setMsgPendingDelete(null);
  }, [selectedChat]);

  const handleClearAll = async () => {
    if (!botId) return false;
    try {
      const response = await client.api.bots[":botId"].conversations.$delete({ param: { botId } });
      if (!response.ok) throw new Error(`Failed to clear conversations (${response.status})`);
      setConversations([]);
      setTotal(0);
      resetConversationDetail(null);
      return true;
    } catch (err) {
      console.error("Failed to clear conversations:", err);
      return false;
    }
  };

  const handleClearChat = async (chatId: number) => {
    if (!botId) return false;
    try {
      const response = await client.api.bots[":botId"].conversations[":chatId"].$delete({
        param: { botId, chatId: String(chatId) },
      });
      if (!response.ok) throw new Error(`Failed to delete conversation (${response.status})`);
      const isLastOnPage = conversations.length === 1;
      setConversations((prev) => prev.filter((c) => c.chatId !== chatId));
      setTotal((prev) => Math.max(0, prev - 1));
      if (selectedChat === chatId) {
        resetConversationDetail(null);
      }
      if (isLastOnPage && page > 1) setPage((current) => current - 1);
      else await loadConversations(true);
      return true;
    } catch (err) {
      console.error("Failed to clear chat:", err);
      return false;
    }
  };

  const openDeleteDialog = (target: { kind: "all" | "chat"; chatId?: number }) => {
    setConfirmDeleteError(null);
    setConfirmDelete(target);
  };

  const closeDeleteDialog = () => {
    if (confirmDeleteBusyRef.current) return;
    setConfirmDeleteError(null);
    setConfirmDelete(null);
  };

  const confirmConversationDelete = async () => {
    if (!confirmDelete || confirmDeleteBusy) return;
    const target = confirmDelete;
    confirmDeleteBusyRef.current = true;
    setConfirmDeleteBusy(true);
    setConfirmDeleteError(null);
    const deleted =
      target.kind === "all"
        ? await handleClearAll()
        : target.chatId !== undefined && (await handleClearChat(target.chatId));
    confirmDeleteBusyRef.current = false;
    setConfirmDeleteBusy(false);

    if (!deleted) {
      setConfirmDeleteError(t("conversations.deleteFailed"));
      return;
    }

    skipDialogFocusRestoreRef.current = true;
    setConfirmDelete(null);
    focusConversationList();
  };

  const armPendingDelete = (
    id: number,
    setPending: (v: number | null) => void,
    timerRef: React.MutableRefObject<ReturnType<typeof setTimeout> | null>,
  ) => {
    if (timerRef.current) clearTimeout(timerRef.current);
    setPending(id);
    timerRef.current = setTimeout(() => {
      setPending(null);
      timerRef.current = null;
    }, PENDING_DELETE_MS);
  };

  const clearPendingDelete = (
    setPending: (v: number | null) => void,
    timerRef: React.MutableRefObject<ReturnType<typeof setTimeout> | null>,
  ) => {
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    setPending(null);
  };

  const handleDeleteSummary = async (id: number) => {
    if (!botId || selectedChat === null) return;
    if (summaries.some((summary) => summary.id === id && summary.isActive)) {
      toast.error(t("conversations.activeSummaryDeleteBlocked"));
      return;
    }
    if (sumPendingDelete !== id) {
      armPendingDelete(id, setSumPendingDelete, sumPendingTimer);
      return;
    }
    clearPendingDelete(setSumPendingDelete, sumPendingTimer);
    setSumDeleteBusy(id);
    try {
      const res = await client.api.bots[":botId"].conversations[":chatId"].summaries[":id"].$delete(
        {
          param: { botId, chatId: String(selectedChat), id: String(id) },
        },
      );
      const json = await res.json();
      if (!res.ok) {
        toast.error(
          res.status === 409
            ? t("conversations.activeSummaryDeleteBlocked")
            : t("conversations.deleteFailed"),
        );
        return;
      }
      if (json.ok) {
        const isLastOnPage = summaries.length === 1;
        setSummaries((prev) => prev.filter((s) => s.id !== id));
        setSumTotal((prev) => Math.max(0, prev - 1));
        setConversations((prev) =>
          prev.map((c) => {
            if (c.chatId !== selectedChat) return c;
            const nextCount = Math.max(0, c.summaryCount - 1);
            return { ...c, summaryCount: nextCount, hasSummaries: nextCount > 0 };
          }),
        );
        if (sumTotal - 1 === 0) {
          setDetailView("messages");
        } else if (isLastOnPage && sumPage > 1) {
          setSumLoading(true);
          setSumPage((p) => p - 1);
        }
      }
    } catch (err) {
      console.error("Failed to delete summary:", err);
    } finally {
      setSumDeleteBusy(null);
    }
  };

  const handleDeleteMessage = async (messageId: number) => {
    if (!botId || selectedChat === null) return;
    if (msgPendingDelete !== messageId) {
      armPendingDelete(messageId, setMsgPendingDelete, msgPendingTimer);
      return;
    }
    clearPendingDelete(setMsgPendingDelete, msgPendingTimer);
    setMsgDeleteBusy(messageId);
    try {
      const res = await client.api.bots[":botId"].conversations[":chatId"].messages[
        ":messageId"
      ].$delete({
        param: { botId, chatId: String(selectedChat), messageId: String(messageId) },
      });
      if (!res.ok) throw new Error(`Failed to delete message (${res.status})`);
      const json = await res.json();
      if (json.ok) {
        const isLastOnPage = messages.length === 1;
        if (isLastOnPage && msgPage > 1) {
          setMsgLoading(true);
          setMsgPage((current) => current - 1);
        } else {
          setMessages((prev) => prev.filter((m) => m.id !== messageId));
        }
        setMsgTotal((prev) => Math.max(0, prev - 1));
        setConversations((prev) =>
          prev.map((c) =>
            c.chatId === selectedChat ? { ...c, messageCount: Math.max(0, c.messageCount - 1) } : c,
          ),
        );
        await loadConversations(true);
      }
    } catch (err) {
      console.error("Failed to delete message:", err);
    } finally {
      setMsgDeleteBusy(null);
    }
  };

  const totalPages = Math.ceil(total / limit);
  const msgTotalPages = Math.ceil(msgTotal / msgLimit);
  const sumTotalPages = Math.max(1, Math.ceil(sumTotal / sumLimit));
  const selectedConv = conversations.find((c) => c.chatId === selectedChat) ?? null;
  const hasSummaries = selectedConv?.hasSummaries ?? false;

  const handleConversationPageChange = (nextPage: number) => {
    setPage(nextPage);
    resetConversationDetail(null);
  };

  const handleSelectConversation = (chatId: number) => {
    if (selectedChat === chatId) return;
    resetConversationDetail(chatId);
    if (!window.matchMedia("(min-width: 80rem)").matches) {
      requestAnimationFrame(() => backButtonRef.current?.focus());
    }
  };

  const handleBackToConversations = () => {
    const previousChat = selectedChat;
    resetConversationDetail(null);
    focusConversationList(previousChat ?? undefined);
  };

  return (
    <>
      <div
        inert={confirmDelete !== null}
        className="flex h-[calc(100dvh-5.5rem)] min-h-[32rem] min-w-0 flex-1 flex-col gap-5 sm:h-[calc(100dvh-6.5rem)] md:h-[calc(100dvh-3rem)] lg:h-[calc(100dvh-5rem)]"
      >
        <div className="shrink-0">
          <div className="min-w-0">
            <h1 className="text-2xl font-semibold tracking-tight text-balance sm:text-[1.7rem]">
              {t("conversations.title")}
            </h1>
            <p className="text-muted-foreground mt-1 hidden text-sm sm:block">
              {t("conversations.description")}
            </p>
          </div>
        </div>

        <div className="grid min-h-0 min-w-0 flex-1 overflow-hidden rounded-[20px] bg-white shadow-[0_0_0_1px_rgb(15_23_42/0.055),0_1px_2px_-1px_rgb(15_23_42/0.06),0_12px_32px_-20px_rgb(15_23_42/0.2)] xl:grid-cols-[minmax(19rem,21rem)_minmax(0,1fr)]">
          <aside
            className={cn(
              "min-h-0 min-w-0 flex-col bg-white xl:border-r xl:border-slate-200/80",
              selectedConv === null ? "flex" : "hidden xl:flex",
            )}
            aria-label={t("conversations.listLabel")}
          >
            <div className="flex h-[72px] shrink-0 items-center justify-between border-b border-slate-200/80 px-4">
              <div>
                <h2
                  ref={conversationListHeadingRef}
                  tabIndex={-1}
                  className="text-sm font-semibold focus:outline-none"
                >
                  {t("conversations.all")}
                </h2>
                <p className="text-muted-foreground mt-0.5 text-xs">
                  {t("conversations.recentFirst")}
                </p>
              </div>
              <div className="flex items-center gap-1">
                <span className="text-muted-foreground rounded-lg bg-slate-100 px-2.5 py-1 text-xs font-semibold tabular-nums">
                  {total}
                </span>
                {total > 0 ? (
                  <Button
                    variant="ghost"
                    size="icon"
                    className="text-muted-foreground hover:text-destructive size-10 transition-[background-color,color,scale] active:scale-[0.96]"
                    onClick={() => openDeleteDialog({ kind: "all" })}
                    aria-label={t("conversations.clearAll")}
                    title={t("conversations.clearAll")}
                  >
                    <Trash2 className="size-4" aria-hidden="true" />
                  </Button>
                ) : null}
              </div>
            </div>

            <div className="min-h-0 flex-1 overflow-hidden p-2" aria-busy={loading}>
              {loading ? (
                <PaneLoading label={t("conversations.loadingConversations")} />
              ) : conversations.length === 0 ? (
                <div className="text-muted-foreground flex h-full min-h-56 flex-col items-center justify-center px-6 text-center">
                  <span className="flex size-11 items-center justify-center rounded-xl bg-slate-100">
                    <Inbox className="size-5" aria-hidden="true" />
                  </span>
                  <p className="text-foreground mt-3 text-sm font-semibold">
                    {t("conversations.empty")}
                  </p>
                  <p className="mt-1 max-w-52 text-xs leading-5">
                    {t("conversations.emptyDescription")}
                  </p>
                </div>
              ) : (
                <ol className="h-full space-y-1 overflow-y-auto overscroll-contain pr-0.5">
                  {conversations.map((conversation) => (
                    <ConversationListItem
                      key={conversation.chatId}
                      conv={conversation}
                      selected={selectedChat === conversation.chatId}
                      onSelect={() => handleSelectConversation(conversation.chatId)}
                      onClear={() =>
                        openDeleteDialog({ kind: "chat", chatId: conversation.chatId })
                      }
                    />
                  ))}
                </ol>
              )}
            </div>

            {totalPages > 1 ? (
              <Pagination
                page={page}
                totalPages={totalPages}
                onPageChange={handleConversationPageChange}
                className="flex shrink-0 items-center justify-center gap-2 border-t border-slate-200/80 px-3 py-2"
              />
            ) : null}
          </aside>

          <section
            className={cn(
              "min-h-0 min-w-0 flex-col bg-slate-50/70",
              selectedConv !== null ? "flex" : "hidden xl:flex",
            )}
            aria-label={t("conversations.detailsLabel")}
          >
            {selectedConv ? (
              <>
                <div className="flex min-h-[72px] shrink-0 items-start gap-2 border-b border-slate-200/80 bg-white px-3 py-2.5 sm:px-4 xl:h-[72px] xl:items-center">
                  <button
                    ref={backButtonRef}
                    type="button"
                    onClick={handleBackToConversations}
                    className="text-muted-foreground hover:text-foreground focus-visible:ring-ring flex size-10 shrink-0 items-center justify-center rounded-lg transition-[background-color,color,scale] duration-150 ease-out hover:bg-slate-100 focus-visible:ring-2 focus-visible:outline-none active:scale-[0.96] xl:hidden"
                    aria-label={t("conversations.backToList")}
                  >
                    <ArrowLeft className="size-5" aria-hidden="true" />
                  </button>
                  <ConversationDetailHeader conv={selectedConv} />
                </div>

                <ConversationToolbar
                  view={detailView}
                  hasSummaries={hasSummaries}
                  summaryCount={selectedConv.summaryCount}
                  showSystem={showSystem}
                  showTools={showTools}
                  onViewChange={setDetailView}
                  onToggleSystem={() => setShowSystem((value) => !value)}
                  onToggleTools={() => setShowTools((value) => !value)}
                />

                {detailView === "messages" ? (
                  <div
                    id="conversation-messages-panel"
                    role="tabpanel"
                    aria-labelledby="conversation-messages-tab"
                    className="flex min-h-0 flex-1 flex-col"
                    aria-busy={msgLoading}
                  >
                    {msgLoading ? (
                      <PaneLoading label={t("conversations.loadingMessages")} />
                    ) : messages.length === 0 ? (
                      <div className="text-muted-foreground flex min-h-56 flex-1 flex-col items-center justify-center px-6 text-center">
                        <span className="flex size-11 items-center justify-center rounded-xl bg-slate-100">
                          <MessageSquareText className="size-5" aria-hidden="true" />
                        </span>
                        <p className="text-foreground mt-3 text-sm font-semibold">
                          {t("conversations.noMessages")}
                        </p>
                        <p className="mt-1 text-xs">{t("conversations.noMessagesDescription")}</p>
                      </div>
                    ) : (
                      <MessagesPane
                        messages={messages}
                        showTools={showTools}
                        showSystem={showSystem}
                        onDelete={handleDeleteMessage}
                        pendingDeleteId={msgPendingDelete}
                        deleteBusyId={msgDeleteBusy}
                        containerRef={msgContainerRef}
                        page={msgPage}
                        totalPages={msgTotalPages}
                        onPageChange={setMsgPage}
                      />
                    )}
                  </div>
                ) : (
                  <div
                    id="conversation-summaries-panel"
                    role="tabpanel"
                    aria-labelledby="conversation-summaries-tab"
                    className="flex min-h-0 flex-1 flex-col"
                    aria-busy={sumLoading}
                  >
                    {sumLoading ? (
                      <PaneLoading label={t("conversations.loadingSummaries")} />
                    ) : summaries.length === 0 ? (
                      <div className="text-muted-foreground flex min-h-56 flex-1 items-center justify-center text-sm">
                        {t("conversations.noSummaries")}
                      </div>
                    ) : (
                      <>
                        <ol className="min-h-0 flex-1 space-y-2.5 overflow-y-auto overscroll-contain p-3 sm:p-4">
                          {summaries.map((summary) => (
                            <li
                              key={summary.id}
                              className="[contain-intrinsic-size:auto_8rem] [content-visibility:auto]"
                            >
                              <SummaryCard
                                summary={summary}
                                onDelete={handleDeleteSummary}
                                pendingDelete={sumPendingDelete === summary.id}
                                busy={sumDeleteBusy === summary.id}
                              />
                            </li>
                          ))}
                        </ol>
                        {sumTotalPages > 1 ? (
                          <Pagination
                            page={sumPage}
                            totalPages={sumTotalPages}
                            onPageChange={setSumPage}
                            className="flex shrink-0 items-center justify-center gap-2 border-t border-slate-200/80 bg-white px-3 py-2"
                          />
                        ) : null}
                      </>
                    )}
                  </div>
                )}
              </>
            ) : (
              <div className="text-muted-foreground flex h-full min-h-72 flex-col items-center justify-center px-8 text-center">
                <span className="flex size-12 items-center justify-center rounded-2xl bg-white text-slate-400 shadow-[0_0_0_1px_rgb(15_23_42/0.06),0_4px_12px_rgb(15_23_42/0.06)]">
                  <MessageSquareText className="size-5" aria-hidden="true" />
                </span>
                <h2 className="text-foreground mt-4 text-sm font-semibold">
                  {t("conversations.select")}
                </h2>
                <p className="mt-1 max-w-xs text-xs leading-5">
                  {t("conversations.selectDescription")}
                </p>
              </div>
            )}
          </section>
        </div>
      </div>

      {confirmDelete ? (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center overscroll-contain bg-slate-950/35 p-4 backdrop-blur-[2px]"
          onClick={(event) => event.target === event.currentTarget && closeDeleteDialog()}
        >
          <div
            ref={deleteDialogRef}
            role="alertdialog"
            aria-modal="true"
            aria-labelledby="delete-title"
            aria-describedby="delete-description"
            className="w-full max-w-sm rounded-[20px] bg-white p-5 shadow-[0_24px_64px_rgb(15_23_42/0.22),0_0_0_1px_rgb(15_23_42/0.08)]"
          >
            <div className="flex items-start gap-3">
              <span className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-red-50 text-red-600">
                <Trash2 className="size-4" aria-hidden="true" />
              </span>
              <div>
                <h2 id="delete-title" className="text-lg font-semibold tracking-tight">
                  {confirmDelete.kind === "all"
                    ? t("conversations.clearAllTitle")
                    : t("conversations.deleteTitle")}
                </h2>
                <p
                  id="delete-description"
                  className="text-muted-foreground mt-1.5 text-sm leading-6 text-pretty"
                >
                  {confirmDelete.kind === "all"
                    ? t("conversations.clearAllDescription")
                    : t("conversations.deleteDescription", { chatId: confirmDelete.chatId })}
                </p>
                {confirmDeleteError ? (
                  <p className="mt-2 text-sm text-red-600" role="alert">
                    {confirmDeleteError}
                  </p>
                ) : null}
              </div>
            </div>
            <div className="mt-5 flex justify-end gap-2">
              <Button
                ref={cancelDeleteButtonRef}
                variant="outline"
                disabled={confirmDeleteBusy}
                onClick={closeDeleteDialog}
              >
                {t("conversations.cancel")}
              </Button>
              <Button
                variant="destructive"
                className="transition-[background-color,scale] active:scale-[0.96]"
                disabled={confirmDeleteBusy}
                onClick={confirmConversationDelete}
              >
                {confirmDeleteBusy ? (
                  <>
                    <Loader2 className="size-4 animate-spin" aria-hidden="true" />
                    {t("conversations.deleting")}
                  </>
                ) : (
                  t("conversations.delete")
                )}
              </Button>
            </div>
          </div>
        </div>
      ) : null}
    </>
  );
}
