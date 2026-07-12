import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Pagination } from "@/components/ui/pagination";
import { client } from "@/lib/client";
import { cn } from "@/lib/utils";
import {
  ArrowLeft,
  BookOpen,
  Loader2,
  MessageSquare,
  Terminal,
  Trash2,
  Wrench,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useParams } from "react-router";
import { PANE_MAX_HEIGHT, PENDING_DELETE_MS } from "./constants";
import { ConversationDetailHeader } from "./conversation-detail-header";
import { ConversationListItem } from "./conversation-list-item";
import { MessagesPane } from "./messages-pane";
import { SummaryCard } from "./summary-card";
import type { ConversationItem, ConversationMessage, ConversationSummary } from "./types";

export function BotConversationsPage() {
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
  const [confirmDelete, setConfirmDelete] = useState<{
    kind: "all" | "chat";
    chatId?: number;
  } | null>(null);

  const msgContainerRef = useRef<HTMLDivElement>(null);
  const msgReqToken = useRef(0);
  const sumReqToken = useRef(0);
  const msgPendingTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const sumPendingTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const limit = 20;
  const msgLimit = 50;
  const sumLimit = 20;

  useEffect(
    () => () => {
      if (msgPendingTimer.current) clearTimeout(msgPendingTimer.current);
      if (sumPendingTimer.current) clearTimeout(sumPendingTimer.current);
    },
    [],
  );

  const loadConversations = useCallback(async () => {
    if (!botId) return;
    setLoading(true);
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
      setLoading(false);
    }
  }, [botId, page]);

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
    if (!botId) return;
    try {
      await client.api.bots[":botId"].conversations.$delete({ param: { botId } });
      setConversations([]);
      setTotal(0);
      setSelectedChat(null);
      setMessages([]);
    } catch (err) {
      console.error("Failed to clear conversations:", err);
    }
  };

  const handleClearChat = async (chatId: number) => {
    if (!botId) return;
    try {
      await client.api.bots[":botId"].conversations[":chatId"].$delete({
        param: { botId, chatId: String(chatId) },
      });
      setConversations((prev) => prev.filter((c) => c.chatId !== chatId));
      if (selectedChat === chatId) {
        setSelectedChat(null);
        setMessages([]);
      }
    } catch (err) {
      console.error("Failed to clear chat:", err);
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

  const handleDeleteSummary = async (id: number) => {
    if (!botId || selectedChat === null) return;
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
    try {
      const res = await client.api.bots[":botId"].conversations[":chatId"].messages[
        ":messageId"
      ].$delete({
        param: { botId, chatId: String(selectedChat), messageId: String(messageId) },
      });
      const json = await res.json();
      if (json.ok) {
        setMessages((prev) => prev.filter((m) => m.id !== messageId));
        setMsgTotal((prev) => prev - 1);
        setConversations((prev) =>
          prev.map((c) =>
            c.chatId === selectedChat ? { ...c, messageCount: c.messageCount - 1 } : c,
          ),
        );
      }
    } catch (err) {
      console.error("Failed to delete message:", err);
    }
  };

  const totalPages = Math.ceil(total / limit);
  const msgTotalPages = Math.ceil(msgTotal / msgLimit);
  const sumTotalPages = Math.max(1, Math.ceil(sumTotal / sumLimit));
  const selectedConv = conversations.find((c) => c.chatId === selectedChat) ?? null;
  const hasSummaries = selectedConv?.hasSummaries ?? false;

  const openSummaries = useCallback(() => setDetailView("summaries"), []);
  const detailHeader = useMemo(() => {
    if (!selectedConv) return null;
    return (
      <ConversationDetailHeader
        conv={selectedConv}
        onOpenSummaries={hasSummaries ? openSummaries : undefined}
      />
    );
  }, [selectedConv, hasSummaries, openSummaries]);

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-4 lg:h-[calc(100vh-7rem)]">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight text-balance">Conversations</h1>
          <p className="text-muted-foreground mt-1 hidden text-sm sm:block">
            Inspect message history and compressed summaries.
          </p>
        </div>
        {conversations.length > 0 && (
          <Button
            variant="outline"
            size="sm"
            className="text-destructive hover:text-destructive active:scale-[0.96]"
            onClick={() => setConfirmDelete({ kind: "all" })}
          >
            <Trash2 className="h-4 w-4" />
            <span className="hidden sm:inline">Clear all</span>
          </Button>
        )}
      </div>

      <div className="grid min-h-0 flex-1 gap-4 lg:grid-cols-[minmax(320px,360px)_minmax(0,1fr)]">
        <Card
          className={cn(
            "min-h-0 flex-col overflow-hidden rounded-2xl",
            selectedChat === null ? "flex" : "hidden lg:flex",
          )}
        >
          <CardHeader>
            <CardTitle className="text-base">Conversations {total > 0 && `(${total})`}</CardTitle>
          </CardHeader>
          <CardContent className="min-h-0 flex-1 overflow-hidden">
            {loading ? (
              <div className="flex items-center justify-center py-8">
                <Loader2 className="h-6 w-6 animate-spin" />
              </div>
            ) : conversations.length === 0 ? (
              <p className="text-muted-foreground py-8 text-center text-sm">No conversations yet</p>
            ) : (
              <div className="flex h-full min-h-0 flex-col">
                <div className="min-h-0 flex-1 space-y-2 overflow-y-auto pr-1">
                  {conversations.map((conv) => (
                    <ConversationListItem
                      key={conv.chatId}
                      conv={conv}
                      selected={selectedChat === conv.chatId}
                      onSelect={() => {
                        setSelectedChat(conv.chatId);
                        setMsgPage(1);
                      }}
                      onClear={() => setConfirmDelete({ kind: "chat", chatId: conv.chatId })}
                    />
                  ))}
                </div>

                <Pagination
                  page={page}
                  totalPages={totalPages}
                  onPageChange={setPage}
                  className="flex items-center justify-center gap-2 pt-3"
                />
              </div>
            )}
          </CardContent>
        </Card>

        <Card
          className={cn(
            "min-h-0 min-w-0 flex-col overflow-hidden rounded-2xl",
            selectedChat !== null ? "flex" : "hidden lg:flex",
          )}
        >
          <CardHeader className="flex-row items-center gap-2">
            {selectedChat !== null && (
              <button
                type="button"
                onClick={() => setSelectedChat(null)}
                className="text-muted-foreground hover:bg-muted -ml-2 flex size-10 shrink-0 items-center justify-center rounded-lg active:scale-[0.96] lg:hidden"
                aria-label="Back to conversations"
              >
                <ArrowLeft className="size-5" />
              </button>
            )}
            <CardTitle className="min-w-0 flex-1 text-base">
              {detailHeader ?? "Select a conversation"}
            </CardTitle>
          </CardHeader>
          <CardContent className="relative min-h-0 flex-1 overflow-hidden">
            {selectedChat === null ? (
              <p className="text-muted-foreground py-8 text-center text-sm">
                Click a conversation to view messages
              </p>
            ) : (
              <>
                <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
                  <div className="flex items-center gap-1">
                    <button
                      type="button"
                      onClick={() => setDetailView("messages")}
                      className={cn(
                        "flex items-center gap-1.5 rounded-md px-2.5 py-1 text-xs transition-colors",
                        detailView === "messages"
                          ? "bg-blue-500/15 text-blue-700 dark:text-blue-300"
                          : "text-muted-foreground hover:bg-zinc-100 dark:hover:bg-zinc-800",
                      )}
                    >
                      <MessageSquare className="h-3 w-3" />
                      Messages
                    </button>
                    <button
                      type="button"
                      disabled={!hasSummaries}
                      onClick={() => setDetailView("summaries")}
                      className={cn(
                        "flex items-center gap-1.5 rounded-md px-2.5 py-1 text-xs transition-colors disabled:opacity-40",
                        detailView === "summaries"
                          ? "bg-amber-500/15 text-amber-700 dark:text-amber-300"
                          : "text-muted-foreground hover:bg-zinc-100 dark:hover:bg-zinc-800",
                      )}
                      title={hasSummaries ? "查看压缩摘要" : "无压缩摘要"}
                    >
                      <BookOpen className="h-3 w-3" />
                      Summaries
                      {hasSummaries && (
                        <span className="ml-0.5 opacity-70">({selectedConv?.summaryCount})</span>
                      )}
                    </button>
                  </div>
                  {detailView === "messages" && (
                    <div className="flex items-center gap-2">
                      <button
                        type="button"
                        className={cn(
                          "flex items-center gap-1.5 rounded-md px-2.5 py-1 text-xs transition-colors",
                          showSystem
                            ? "bg-purple-500/15 text-purple-700 dark:text-purple-300"
                            : "bg-zinc-100 text-zinc-500 hover:bg-zinc-200 dark:bg-zinc-800 dark:text-zinc-400 dark:hover:bg-zinc-700",
                        )}
                        onClick={() => setShowSystem((v) => !v)}
                      >
                        <Terminal className="h-3 w-3" />
                        {showSystem ? "Hide system" : "Show system"}
                      </button>
                      <button
                        type="button"
                        className={cn(
                          "flex items-center gap-1.5 rounded-md px-2.5 py-1 text-xs transition-colors",
                          showTools
                            ? "bg-orange-500/15 text-orange-700 dark:text-orange-300"
                            : "bg-zinc-100 text-zinc-500 hover:bg-zinc-200 dark:bg-zinc-800 dark:text-zinc-400 dark:hover:bg-zinc-700",
                        )}
                        onClick={() => setShowTools((v) => !v)}
                      >
                        <Wrench className="h-3 w-3" />
                        {showTools ? "Hide tools" : "Show tools"}
                      </button>
                    </div>
                  )}
                </div>
                {detailView === "messages" ? (
                  msgLoading ? (
                    <div className="flex items-center justify-center py-8">
                      <Loader2 className="h-6 w-6 animate-spin" />
                    </div>
                  ) : messages.length === 0 ? (
                    <p className="text-muted-foreground py-8 text-center text-sm">No messages</p>
                  ) : (
                    <MessagesPane
                      messages={messages}
                      showTools={showTools}
                      showSystem={showSystem}
                      onDelete={handleDeleteMessage}
                      pendingDeleteId={msgPendingDelete}
                      containerRef={msgContainerRef}
                      page={msgPage}
                      totalPages={msgTotalPages}
                      onPageChange={setMsgPage}
                    />
                  )
                ) : sumLoading ? (
                  <div className="flex items-center justify-center py-8">
                    <Loader2 className="h-6 w-6 animate-spin" />
                  </div>
                ) : summaries.length === 0 ? (
                  <p className="text-muted-foreground py-8 text-center text-sm">No summaries</p>
                ) : (
                  <div className="space-y-3">
                    <div className={cn(PANE_MAX_HEIGHT, "space-y-3 overflow-y-auto pr-1")}>
                      {summaries.map((s) => (
                        <SummaryCard
                          key={s.id}
                          summary={s}
                          onDelete={handleDeleteSummary}
                          pendingDelete={sumPendingDelete === s.id}
                          busy={sumDeleteBusy === s.id}
                        />
                      ))}
                    </div>
                    <Pagination
                      page={sumPage}
                      totalPages={sumTotalPages}
                      onPageChange={setSumPage}
                      className="flex items-center justify-center gap-2 pt-3"
                    />
                  </div>
                )}
              </>
            )}
          </CardContent>
        </Card>
      </div>
      {confirmDelete && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
          onMouseDown={(event) => event.target === event.currentTarget && setConfirmDelete(null)}
        >
          <div
            role="alertdialog"
            aria-modal="true"
            aria-labelledby="delete-title"
            className="bg-background w-full max-w-sm rounded-2xl p-5 shadow-2xl ring-1 ring-black/10 dark:ring-white/10"
          >
            <h2 id="delete-title" className="text-lg font-semibold">
              {confirmDelete.kind === "all"
                ? "Clear all conversations?"
                : "Delete this conversation?"}
            </h2>
            <p className="text-muted-foreground mt-2 text-sm text-pretty">
              {confirmDelete.kind === "all"
                ? "Every conversation and its messages will be permanently deleted."
                : `Chat ${confirmDelete.chatId} and all of its messages will be permanently deleted.`}
            </p>
            <div className="mt-5 flex justify-end gap-2">
              <Button variant="outline" onClick={() => setConfirmDelete(null)}>
                Cancel
              </Button>
              <Button
                variant="destructive"
                onClick={async () => {
                  const target = confirmDelete;
                  setConfirmDelete(null);
                  if (target.kind === "all") await handleClearAll();
                  else if (target.chatId !== undefined) await handleClearChat(target.chatId);
                }}
              >
                Delete
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
