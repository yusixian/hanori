import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Pagination } from "@/components/ui/pagination";
import { client } from "@/lib/client";
import { cn } from "@/lib/utils";
import {
  ArrowLeft,
  Inbox,
  Loader2,
  MessageSquareText,
  RefreshCw,
  Search,
  Trash2,
} from "lucide-react";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useParams } from "react-router";
import { PENDING_DELETE_MS } from "./constants";
import { ConversationDetailHeader } from "./conversation-detail-header";
import { ConversationListItem } from "./conversation-list-item";
import { ConversationToolbar } from "./conversation-toolbar";
import { MessagesPane } from "./messages-pane";
import { SummaryCard } from "./summary-card";
import { useConversationPage } from "./use-conversation-page";

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
  const { botId } = useParams<{ botId: string }>();
  return <BotConversationsContent key={botId} botId={botId} />;
}

function ReadFailure({
  label,
  stale,
  retry,
  disabled,
  firstPage,
}: {
  label: string;
  stale: boolean;
  retry: () => void;
  disabled: boolean;
  firstPage?: () => void;
}) {
  const { t } = useTranslation("bots");
  return (
    <div
      role="alert"
      className="m-3 flex shrink-0 flex-wrap items-center gap-3 rounded-xl border border-amber-200 bg-amber-50 p-3 text-sm"
    >
      <div className="min-w-0 flex-1">
        <p className="font-medium">{label}</p>
        {stale ? <p className="mt-1 text-xs leading-5">{t("conversations.staleData")}</p> : null}
      </div>
      {firstPage ? (
        <Button variant="ghost" size="sm" disabled={disabled} onClick={firstPage}>
          {t("conversations.firstPage")}
        </Button>
      ) : null}
      <Button variant="outline" size="sm" disabled={disabled} onClick={retry}>
        {t("conversations.retry")}
      </Button>
    </div>
  );
}

function BotConversationsContent({ botId }: { botId: string | undefined }) {
  const { t } = useTranslation("bots");
  const [page, setPage] = useState(1);
  const [searchDraft, setSearchDraft] = useState("");
  const [search, setSearch] = useState("");
  const searchInputRef = useRef<HTMLInputElement>(null);
  const [selectedChat, setSelectedChat] = useState<number | null>(null);
  const [msgPage, setMsgPage] = useState(1);
  const [showTools, setShowTools] = useState(false);
  const [showSystem, setShowSystem] = useState(false);
  const [detailView, setDetailView] = useState<"messages" | "summaries">("messages");
  const [sumPage, setSumPage] = useState(1);
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

  const [notice, setNotice] = useState<{
    kind: "unknown" | "deleted" | "active";
    needsRefresh: boolean;
  } | null>(null);
  const [recovering, setRecovering] = useState(false);
  const mountedRef = useRef(false);
  const mutationRef = useRef(false);
  const recoveryRequiredRef = useRef(false);
  const recoveryTargetRef = useRef<{
    key: string;
    request: (signal: AbortSignal) => Promise<unknown>;
  } | null>(null);
  const recoveryControllerRef = useRef<AbortController | null>(null);
  const msgContainerRef = useRef<HTMLDivElement>(null);
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

  const requestConversations = useCallback(
    async (signal: AbortSignal) => {
      if (!botId) throw new Error("Missing Bot");
      const response = await client.api.bots[":botId"].conversations.$get(
        {
          param: { botId },
          query: { page: String(page), limit: String(limit), search: search || undefined },
        },
        { init: { signal } },
      );
      if (!response.ok) throw new Error("Conversation request failed");
      const json = await response.json();
      if (!json.ok) throw new Error("Conversation request failed");
      return json;
    },
    [botId, page, search],
  );
  const requestMessages = useCallback(
    async (signal: AbortSignal) => {
      if (!botId || selectedChat === null) throw new Error("Missing conversation");
      const response = await client.api.bots[":botId"].conversations[":chatId"].$get(
        {
          param: { botId, chatId: String(selectedChat) },
          query: { page: String(msgPage), limit: String(msgLimit) },
        },
        { init: { signal } },
      );
      if (!response.ok) throw new Error("Message request failed");
      const json = await response.json();
      if (!json.ok) throw new Error("Message request failed");
      return json;
    },
    [botId, selectedChat, msgPage],
  );
  const requestSummaries = useCallback(
    async (signal: AbortSignal) => {
      if (!botId || selectedChat === null) throw new Error("Missing conversation");
      const response = await client.api.bots[":botId"].conversations[":chatId"].summaries.$get(
        {
          param: { botId, chatId: String(selectedChat) },
          query: { page: String(sumPage), limit: String(sumLimit) },
        },
        { init: { signal } },
      );
      if (!response.ok) throw new Error("Summary request failed");
      const json = await response.json();
      if (!json.ok) throw new Error("Summary request failed");
      return json;
    },
    [botId, selectedChat, sumPage],
  );
  const listKey = JSON.stringify([page, search]);
  const list = useConversationPage(listKey, requestConversations);
  const messageList = useConversationPage(
    selectedChat !== null && detailView === "messages" ? `${selectedChat}:${msgPage}` : null,
    requestMessages,
  );
  const summaryList = useConversationPage(
    selectedChat !== null && detailView === "summaries" ? `${selectedChat}:${sumPage}` : null,
    requestSummaries,
  );
  const conversations = list.result?.data ?? [];
  const total = list.result?.total ?? 0;
  const messages = messageList.result?.data ?? [];
  const msgTotal = messageList.result?.total ?? 0;
  const summaries = summaryList.result?.data ?? [];
  const sumTotal = summaryList.result?.total ?? 0;
  const loading = list.loading;
  const msgLoading = messageList.loading;
  const sumLoading = summaryList.loading;
  const interactionBusy =
    confirmDeleteBusy || msgDeleteBusy !== null || sumDeleteBusy !== null || recovering;
  const writesDisabled =
    interactionBusy || notice?.needsRefresh === true || loading || list.failed || !list.result;

  const resetConversationDetail = useCallback((chatId: number | null) => {
    setSelectedChat(chatId);
    setMsgPage(1);
    setSumPage(1);
    setDetailView("messages");
    setMsgPendingDelete(null);
    setSumPendingDelete(null);
    if (msgPendingTimer.current) clearTimeout(msgPendingTimer.current);
    if (sumPendingTimer.current) clearTimeout(sumPendingTimer.current);
  }, []);

  useLayoutEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      recoveryControllerRef.current?.abort();
    };
  }, []);

  useEffect(() => {
    if (list.result && !loading && !list.failed && !interactionBusy) {
      const lastPage = Math.max(1, Math.ceil(total / limit));
      if (page > lastPage) setPage(lastPage);
      if (selectedChat !== null && !conversations.some((item) => item.chatId === selectedChat))
        resetConversationDetail(null);
    }
  }, [
    list.result,
    loading,
    list.failed,
    total,
    page,
    selectedChat,
    conversations,
    resetConversationDetail,
    interactionBusy,
  ]);
  useEffect(() => {
    if (messageList.result && !msgLoading && !messageList.failed) {
      setMsgPage((current) => Math.min(current, Math.max(1, Math.ceil(msgTotal / msgLimit))));
      msgContainerRef.current?.scrollTo({ top: 0 });
    }
  }, [messageList.result, msgLoading, messageList.failed, msgTotal]);
  useEffect(() => {
    if (summaryList.result && !sumLoading && !summaryList.failed)
      setSumPage((current) => Math.min(current, Math.max(1, Math.ceil(sumTotal / sumLimit))));
  }, [summaryList.result, sumLoading, summaryList.failed, sumTotal]);

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

  const refreshDisplayedData = async () => {
    const results = await Promise.all([
      list.refresh(),
      selectedChat === null
        ? Promise.resolve(true)
        : detailView === "messages"
          ? messageList.refresh()
          : summaryList.refresh(),
    ]);
    return results.every(Boolean);
  };

  const recoverDeletion = async () => {
    if (mutationRef.current) return;
    mutationRef.current = true;
    confirmDeleteBusyRef.current = true;
    setRecovering(true);
    try {
      const target = recoveryTargetRef.current;
      const displayedKeys = [
        `list:${listKey}`,
        detailView === "messages"
          ? `message:${selectedChat}:${msgPage}`
          : `summary:${selectedChat}:${sumPage}`,
      ];
      const controller = new AbortController();
      recoveryControllerRef.current = controller;
      // Navigation remains available after a failure. Verify the original target
      // too, without letting its old scope replace the page now being viewed.
      const verifyOriginal = async () => {
        if (!target || displayedKeys.includes(target.key)) return true;
        try {
          await target.request(controller.signal);
          return true;
        } catch {
          return false;
        }
      };
      const results = await Promise.all([refreshDisplayedData(), verifyOriginal()]);
      if (!mountedRef.current) return;
      if (results.every(Boolean)) {
        recoveryTargetRef.current = null;
        recoveryRequiredRef.current = false;
        setNotice((current) =>
          current?.kind === "deleted" ? { kind: "deleted", needsRefresh: false } : null,
        );
        setConfirmDeleteError(null);
        if (confirmDelete) {
          skipDialogFocusRestoreRef.current = true;
          setConfirmDelete(null);
          focusConversationList();
        } else {
          requestAnimationFrame(() => {
            const tab = document.getElementById(`conversation-${detailView}-tab`);
            (tab ?? conversationListHeadingRef.current)?.focus();
          });
        }
      }
    } finally {
      mutationRef.current = false;
      confirmDeleteBusyRef.current = false;
      if (mountedRef.current) setRecovering(false);
    }
  };

  const openDeleteDialog = (target: { kind: "all" | "chat"; chatId?: number }) => {
    if (mutationRef.current || recoveryRequiredRef.current || writesDisabled) return;
    setConfirmDeleteError(null);
    setConfirmDelete(target);
  };

  const closeDeleteDialog = () => {
    if (confirmDeleteBusyRef.current) return;
    setConfirmDeleteError(null);
    setConfirmDelete(null);
  };

  const confirmConversationDelete = async () => {
    if (!confirmDelete || mutationRef.current || !botId) return;
    if (confirmDeleteError) {
      await recoverDeletion();
      return;
    }
    if (recoveryRequiredRef.current) return;
    const target = confirmDelete;
    recoveryTargetRef.current = { key: `list:${listKey}`, request: requestConversations };
    mutationRef.current = true;
    confirmDeleteBusyRef.current = true;
    setConfirmDeleteBusy(true);
    setNotice(null);
    try {
      const response =
        target.kind === "all"
          ? await client.api.bots[":botId"].conversations.$delete({ param: { botId } })
          : await client.api.bots[":botId"].conversations[":chatId"].$delete({
              param: { botId, chatId: String(target.chatId) },
            });
      if (!response.ok || !(await response.json()).ok) throw new Error("Delete not confirmed");
      if (!mountedRef.current) return;
      resetConversationDetail(null);
      setNotice({ kind: "deleted", needsRefresh: false });
      const refreshed = await list.refresh();
      if (!mountedRef.current) return;
      recoveryRequiredRef.current = !refreshed;
      if (refreshed) recoveryTargetRef.current = null;
      setNotice({ kind: "deleted", needsRefresh: !refreshed });
      skipDialogFocusRestoreRef.current = true;
      setConfirmDelete(null);
      focusConversationList();
    } catch {
      if (mountedRef.current) {
        recoveryRequiredRef.current = true;
        setNotice({ kind: "unknown", needsRefresh: true });
        setConfirmDeleteError(t("conversations.deleteUnconfirmed"));
      }
    } finally {
      mutationRef.current = false;
      confirmDeleteBusyRef.current = false;
      if (mountedRef.current) setConfirmDeleteBusy(false);
    }
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

  const deleteItem = async (kind: "message" | "summary", id: number) => {
    if (
      !botId ||
      selectedChat === null ||
      mutationRef.current ||
      recoveryRequiredRef.current ||
      writesDisabled
    )
      return;
    const resource = kind === "message" ? messageList : summaryList;
    if (resource.loading || resource.failed || !resource.result) return;
    if (kind === "summary" && summaries.some((summary) => summary.id === id && summary.isActive))
      return;
    const pending = kind === "message" ? msgPendingDelete : sumPendingDelete;
    const setPending = kind === "message" ? setMsgPendingDelete : setSumPendingDelete;
    const timer = kind === "message" ? msgPendingTimer : sumPendingTimer;
    if (pending !== id) {
      armPendingDelete(id, setPending, timer);
      return;
    }
    clearPendingDelete(setPending, timer);
    recoveryTargetRef.current =
      kind === "message"
        ? { key: `message:${selectedChat}:${msgPage}`, request: requestMessages }
        : { key: `summary:${selectedChat}:${sumPage}`, request: requestSummaries };
    mutationRef.current = true;
    const setBusy = kind === "message" ? setMsgDeleteBusy : setSumDeleteBusy;
    setBusy(id);
    setNotice(null);
    try {
      const response =
        kind === "message"
          ? await client.api.bots[":botId"].conversations[":chatId"].messages[":messageId"].$delete(
              { param: { botId, chatId: String(selectedChat), messageId: String(id) } },
            )
          : await client.api.bots[":botId"].conversations[":chatId"].summaries[":id"].$delete({
              param: { botId, chatId: String(selectedChat), id: String(id) },
            });
      if (kind === "summary" && response.status === 409) {
        if (mountedRef.current) {
          recoveryRequiredRef.current = true;
          setNotice({ kind: "active", needsRefresh: true });
        }
        return;
      }
      if (!response.ok || !(await response.json()).ok) throw new Error("Delete not confirmed");
      if (!mountedRef.current) return;
      setNotice({ kind: "deleted", needsRefresh: false });
      const refreshed = await refreshDisplayedData();
      if (!mountedRef.current) return;
      recoveryRequiredRef.current = !refreshed;
      if (refreshed) recoveryTargetRef.current = null;
      setNotice({ kind: "deleted", needsRefresh: !refreshed });
    } catch {
      if (mountedRef.current) {
        recoveryRequiredRef.current = true;
        setNotice({ kind: "unknown", needsRefresh: true });
      }
    } finally {
      mutationRef.current = false;
      if (mountedRef.current) setBusy(null);
    }
  };
  const handleDeleteSummary = (id: number) => deleteItem("summary", id);
  const handleDeleteMessage = (id: number) => deleteItem("message", id);

  const totalPages = Math.ceil(total / limit);
  const msgTotalPages = Math.ceil(msgTotal / msgLimit);
  const sumTotalPages = Math.max(1, Math.ceil(sumTotal / sumLimit));
  const selectedConv = conversations.find((c) => c.chatId === selectedChat) ?? null;
  const hasSummaries = detailView === "summaries" || (selectedConv?.hasSummaries ?? false);

  const handleConversationPageChange = (nextPage: number) => {
    if (mutationRef.current) return;
    setPage(nextPage);
    resetConversationDetail(null);
  };

  const applySearch = (value: string) => {
    if (mutationRef.current) return;
    const next = value.trim();
    setSearchDraft(next);
    if (next === search && page === 1) return;
    setSearch(next);
    setPage(1);
    resetConversationDetail(null);
  };

  const handleSelectConversation = (chatId: number) => {
    if (mutationRef.current || selectedChat === chatId) return;
    resetConversationDetail(chatId);
    if (!window.matchMedia("(min-width: 80rem)").matches) {
      requestAnimationFrame(() => backButtonRef.current?.focus());
    }
  };

  const handleBackToConversations = () => {
    if (mutationRef.current) return;
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

        {notice ? (
          <div
            role={notice.needsRefresh ? "alert" : "status"}
            className="flex shrink-0 flex-wrap items-center gap-3 rounded-xl border border-slate-200 bg-white px-4 py-3 text-sm"
          >
            <p className="min-w-0 flex-1">
              {notice.kind === "active"
                ? t("conversations.activeSummaryDeleteBlocked")
                : notice.kind === "unknown"
                  ? t("conversations.deleteUnconfirmed")
                  : notice.needsRefresh
                    ? t("conversations.deletedRefreshFailed")
                    : t("conversations.deleted")}
            </p>
            {notice.needsRefresh ? (
              <Button
                variant="outline"
                size="sm"
                disabled={interactionBusy}
                onClick={recoverDeletion}
              >
                {recovering ? t("conversations.refreshing") : t("conversations.refreshAndCheck")}
              </Button>
            ) : null}
          </div>
        ) : null}

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
                  {t(search ? "conversations.searchResults" : "conversations.all")}
                </h2>
                <p className="text-muted-foreground mt-0.5 text-xs">
                  {t("conversations.recentFirst")}
                </p>
              </div>
              <div className="flex items-center gap-1">
                {list.result ? (
                  <span
                    title={loading || list.failed ? t("conversations.staleData") : undefined}
                    className="text-muted-foreground rounded-lg bg-slate-100 px-2.5 py-1 text-xs font-semibold tabular-nums"
                  >
                    {total}
                  </span>
                ) : null}
                <Button
                  variant="ghost"
                  size="icon"
                  disabled={loading || interactionBusy}
                  onClick={() => {
                    void (recoveryRequiredRef.current ? recoverDeletion() : list.refresh());
                  }}
                  aria-label={t("conversations.refreshConversations")}
                >
                  <RefreshCw
                    className={cn("size-4", loading && "animate-spin")}
                    aria-hidden="true"
                  />
                </Button>
                <Button
                  variant="ghost"
                  size="icon"
                  className="text-muted-foreground hover:text-destructive size-10 transition-[background-color,color,scale] active:scale-[0.96]"
                  disabled={writesDisabled || (!search && total === 0)}
                  onClick={() => openDeleteDialog({ kind: "all" })}
                  aria-label={t("conversations.clearAll")}
                  title={t("conversations.clearAll")}
                >
                  <Trash2 className="size-4" aria-hidden="true" />
                </Button>
              </div>
            </div>

            <form
              role="search"
              aria-label={t("conversations.searchConversations")}
              className="shrink-0 border-b border-slate-200/80 px-4 py-3"
              onSubmit={(event) => {
                event.preventDefault();
                applySearch(searchDraft);
              }}
            >
              <label htmlFor="conversation-search" className="mb-1.5 block text-xs font-medium">
                {t("conversations.searchLabel")}
              </label>
              <div className="flex items-center gap-2">
                <Input
                  ref={searchInputRef}
                  id="conversation-search"
                  className="[&::-webkit-search-cancel-button]:hidden"
                  type="search"
                  value={searchDraft}
                  maxLength={100}
                  disabled={interactionBusy}
                  aria-describedby="conversation-search-hint"
                  onChange={(event) => setSearchDraft(event.target.value)}
                  onKeyDown={(event) => {
                    if (
                      event.key === "Enter" &&
                      (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229)
                    )
                      event.preventDefault();
                  }}
                />
                <Button
                  type="submit"
                  variant="outline"
                  size="icon"
                  className="shrink-0"
                  disabled={interactionBusy}
                  aria-label={t("conversations.searchConversations")}
                >
                  <Search className="size-4" aria-hidden="true" />
                </Button>
              </div>
              <p
                id="conversation-search-hint"
                className="text-muted-foreground mt-2 text-xs leading-5"
              >
                {t("conversations.searchHint")}
              </p>
              {search || searchDraft ? (
                <div className="mt-1 flex items-start justify-between gap-2">
                  <p role="status" className="min-w-0 text-xs leading-5 break-words">
                    {search ? t("conversations.searchApplied", { query: search }) : null}
                  </p>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="h-8 shrink-0 px-2 text-xs"
                    disabled={interactionBusy}
                    onClick={() => {
                      applySearch("");
                      searchInputRef.current?.focus();
                    }}
                  >
                    {t("conversations.clearSearch")}
                  </Button>
                </div>
              ) : null}
            </form>

            <div className="flex min-h-0 flex-1 flex-col overflow-hidden p-2" aria-busy={loading}>
              {list.failed ? (
                <ReadFailure
                  label={t("conversations.loadConversationsFailed")}
                  firstPage={
                    !list.result && page > 1 ? () => handleConversationPageChange(1) : undefined
                  }
                  stale={list.result !== null}
                  disabled={interactionBusy}
                  retry={() => {
                    void (recoveryRequiredRef.current ? recoverDeletion() : list.refresh());
                  }}
                />
              ) : null}
              {loading && list.result ? (
                <p role="status" className="text-muted-foreground px-3 py-2 text-xs">
                  {t("conversations.refreshing")}
                </p>
              ) : null}
              {!list.result ? (
                loading ? (
                  <PaneLoading label={t("conversations.loadingConversations")} />
                ) : null
              ) : conversations.length === 0 ? (
                <div className="text-muted-foreground flex h-full min-h-56 flex-col items-center justify-center px-6 text-center">
                  <span className="flex size-11 items-center justify-center rounded-xl bg-slate-100">
                    <Inbox className="size-5" aria-hidden="true" />
                  </span>
                  <p className="text-foreground mt-3 text-sm font-semibold">
                    {t(search ? "conversations.searchEmpty" : "conversations.empty")}
                  </p>
                  <p className="mt-1 max-w-52 text-xs leading-5">
                    {t(
                      search
                        ? "conversations.searchEmptyDescription"
                        : "conversations.emptyDescription",
                    )}
                  </p>
                </div>
              ) : (
                <ol className="h-full space-y-1 overflow-y-auto overscroll-contain pr-0.5">
                  {conversations.map((conversation) => (
                    <ConversationListItem
                      key={conversation.chatId}
                      conv={conversation}
                      selected={selectedChat === conversation.chatId}
                      navigationDisabled={interactionBusy}
                      deleteDisabled={writesDisabled}
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
                disabled={interactionBusy}
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
                    disabled={interactionBusy}
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
                  disabled={interactionBusy}
                  refreshing={detailView === "messages" ? msgLoading : sumLoading}
                  onRefresh={() => {
                    if (!mutationRef.current)
                      void (recoveryRequiredRef.current
                        ? recoverDeletion()
                        : detailView === "messages"
                          ? messageList.refresh()
                          : summaryList.refresh());
                  }}
                  onViewChange={(next) => {
                    if (mutationRef.current) return;
                    setMsgPendingDelete(null);
                    setSumPendingDelete(null);
                    setDetailView(next);
                  }}
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
                    {messageList.failed ? (
                      <ReadFailure
                        label={t("conversations.loadMessagesFailed")}
                        firstPage={
                          !messageList.result && msgPage > 1 ? () => setMsgPage(1) : undefined
                        }
                        stale={messageList.result !== null}
                        disabled={interactionBusy}
                        retry={() => {
                          void (recoveryRequiredRef.current
                            ? recoverDeletion()
                            : messageList.refresh());
                        }}
                      />
                    ) : null}
                    {msgLoading && messageList.result ? (
                      <p role="status" className="text-muted-foreground px-4 py-2 text-xs">
                        {t("conversations.refreshing")}
                      </p>
                    ) : null}
                    {!messageList.result ? (
                      msgLoading ? (
                        <PaneLoading label={t("conversations.loadingMessages")} />
                      ) : null
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
                        deleteDisabled={writesDisabled || msgLoading || messageList.failed}
                        navigationDisabled={interactionBusy}
                        containerRef={msgContainerRef}
                        page={msgPage}
                        totalPages={msgTotalPages}
                        onPageChange={(next) => {
                          if (!mutationRef.current) {
                            setMsgPendingDelete(null);
                            setMsgPage(next);
                          }
                        }}
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
                    {summaryList.failed ? (
                      <ReadFailure
                        label={t("conversations.loadSummariesFailed")}
                        firstPage={
                          !summaryList.result && sumPage > 1 ? () => setSumPage(1) : undefined
                        }
                        stale={summaryList.result !== null}
                        disabled={interactionBusy}
                        retry={() => {
                          void (recoveryRequiredRef.current
                            ? recoverDeletion()
                            : summaryList.refresh());
                        }}
                      />
                    ) : null}
                    {sumLoading && summaryList.result ? (
                      <p role="status" className="text-muted-foreground px-4 py-2 text-xs">
                        {t("conversations.refreshing")}
                      </p>
                    ) : null}
                    {!summaryList.result ? (
                      sumLoading ? (
                        <PaneLoading label={t("conversations.loadingSummaries")} />
                      ) : null
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
                                disabled={writesDisabled || sumLoading || summaryList.failed}
                              />
                            </li>
                          ))}
                        </ol>
                        {sumTotalPages > 1 ? (
                          <Pagination
                            page={sumPage}
                            totalPages={sumTotalPages}
                            disabled={interactionBusy}
                            onPageChange={(next) => {
                              if (!mutationRef.current) {
                                setSumPendingDelete(null);
                                setSumPage(next);
                              }
                            }}
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
                disabled={confirmDeleteBusy || recovering}
                onClick={closeDeleteDialog}
              >
                {t("conversations.cancel")}
              </Button>
              <Button
                variant="destructive"
                className="transition-[background-color,scale] active:scale-[0.96]"
                disabled={confirmDeleteBusy || recovering}
                onClick={confirmConversationDelete}
              >
                {recovering ? (
                  t("conversations.refreshing")
                ) : confirmDeleteBusy ? (
                  <>
                    <Loader2 className="size-4 animate-spin" aria-hidden="true" />
                    {t("conversations.deleting")}
                  </>
                ) : confirmDeleteError ? (
                  t("conversations.refreshAndCheck")
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
