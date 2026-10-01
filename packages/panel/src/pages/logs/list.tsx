import {
  LogEntryRow,
  logMatchesFilters,
  mergeLogEntries,
  type LogEntryLabels,
} from "@/components/logs/log-entry-row";
import { Pagination } from "@/components/ui/pagination";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Popover } from "@/components/ui/popover";
import { Select } from "@/components/ui/select";
import { useSSEConnection } from "@/hooks/use-sse-connection";
import { client } from "@/lib/client";
import type { BotWithStatus, LogEntry } from "@cos-tool-bot/shared";
import { useInvalidate, useList } from "@refinedev/core";
import {
  AlertCircle,
  Check,
  ChevronDown,
  Pause,
  Play,
  Radio,
  RotateCw,
  Search,
  Trash2,
} from "lucide-react";
import { useEffect, useId, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useSearchParams } from "react-router";

const BOT_OPTIONS_PAGE_SIZE = 100;

async function loadAllBotOptions(signal: AbortSignal): Promise<BotWithStatus[]> {
  const options = new Map<string, BotWithStatus>();
  let page = 1;
  let expectedTotal: number | undefined;

  while (true) {
    const response = await client.api.bots.$get(
      { query: { page: String(page), limit: String(BOT_OPTIONS_PAGE_SIZE) } },
      { init: { signal } },
    );
    if (!response.ok) throw new Error("Bot list request failed");
    const result = await response.json();
    if (!result.ok) throw new Error("Bot list request failed");
    expectedTotal ??= result.total;
    if (result.total !== expectedTotal) throw new Error("Bot list changed during pagination");
    for (const bot of result.data) options.set(bot.id, bot);

    const totalPages = Math.max(1, Math.ceil(expectedTotal / BOT_OPTIONS_PAGE_SIZE));
    if (page >= totalPages) {
      if (options.size !== expectedTotal) throw new Error("Bot list pagination was incomplete");
      return [...options.values()];
    }
    if (result.data.length === 0) throw new Error("Bot list pagination was incomplete");
    page += 1;
  }
}

export function LogsListPage() {
  const { t, i18n } = useTranslation("admin");
  const [searchParams, setSearchParams] = useSearchParams();
  const [page, setPage] = useState(1);
  const [level, setLevel] = useState("");
  const botId = searchParams.get("botId") ?? "";
  const previousBotIdRef = useRef(botId);
  const [botOptions, setBotOptions] = useState<BotWithStatus[]>([]);
  const [botOptionsError, setBotOptionsError] = useState(false);
  const [botOptionsRetry, setBotOptionsRetry] = useState(0);
  const [botOptionsLoading, setBotOptionsLoading] = useState(true);
  const [botPickerOpen, setBotPickerOpen] = useState(false);
  const [botQuery, setBotQuery] = useState("");
  const [activeBotIndex, setActiveBotIndex] = useState(-1);
  const botListboxId = useId();
  const botListboxRef = useRef<HTMLDivElement>(null);
  const allBotsOptionRef = useRef<HTMLButtonElement>(null);
  const botPickerInputRef = useRef<HTMLInputElement>(null);
  const [searchInput, setSearchInput] = useState("");
  const [search, setSearch] = useState("");
  const [chatIdInput, setChatIdInput] = useState("");
  const [chatId, setChatId] = useState("");
  const [correlationIdInput, setCorrelationIdInput] = useState("");
  const [correlationId, setCorrelationId] = useState("");
  const [clearError, setClearError] = useState<string | null>(null);
  const composingRef = useRef(false);
  const retryInProgressRef = useRef(false);
  const [livePaused, setLivePaused] = useState(false);
  const [pausedLiveLogs, setPausedLiveLogs] = useState<LogEntry[]>([]);

  const sseUrl = useMemo(
    () => (botId ? `/api/logs/stream?botId=${botId}` : "/api/logs/stream"),
    [botId],
  );
  const { connected, liveLogs, clearLiveLogs } = useSSEConnection(sseUrl);

  useEffect(() => {
    if (previousBotIdRef.current === botId) return;
    previousBotIdRef.current = botId;
    setPage(1);
    clearLiveLogs();
    setPausedLiveLogs([]);
    setLivePaused(false);
  }, [botId, clearLiveLogs]);

  // Fetch bot options for filter
  useEffect(() => {
    const controller = new AbortController();
    let active = true;
    void loadAllBotOptions(controller.signal)
      .then((options) => {
        if (!active) return;
        const retryButtonWasFocused =
          retryInProgressRef.current && document.activeElement?.id === "logs-bot-options-retry";
        retryInProgressRef.current = false;
        if (retryButtonWasFocused) document.getElementById("logs-bot-filter")?.focus();
        setBotOptions(options);
        setBotOptionsError(false);
        setBotOptionsLoading(false);
      })
      .catch(() => {
        if (!active || controller.signal.aborted) return;
        retryInProgressRef.current = false;
        setBotOptionsError(true);
        setBotOptionsLoading(false);
      });

    return () => {
      active = false;
      controller.abort();
    };
  }, [botOptionsRetry]);

  useEffect(() => {
    if (composingRef.current) return;
    const timeout = window.setTimeout(() => {
      setSearch(searchInput.trim());
      setPage(1);
    }, 300);
    return () => window.clearTimeout(timeout);
  }, [searchInput]);

  const filters = [];
  if (level) filters.push({ field: "level", operator: "eq" as const, value: level });
  if (botId) filters.push({ field: "botId", operator: "eq" as const, value: botId });
  if (search) filters.push({ field: "search", operator: "eq" as const, value: search });
  if (chatId) filters.push({ field: "chatId", operator: "eq" as const, value: chatId });
  if (correlationId)
    filters.push({ field: "correlationId", operator: "eq" as const, value: correlationId });

  const { data, isLoading, isError, refetch } = useList<LogEntry>({
    resource: "logs",
    pagination: { current: page, pageSize: 50 },
    filters,
  });

  const invalidate = useInvalidate();

  const selectedBot = botOptions.find((bot) => bot.id === botId);
  const normalizedBotQuery = botQuery.trim().toLocaleLowerCase();
  const filteredBotOptions = useMemo(
    () => botOptions.filter((bot) => bot.name.toLocaleLowerCase().includes(normalizedBotQuery)),
    [botOptions, normalizedBotQuery],
  );
  const visibleBotOptions = useMemo(() => {
    if (!botId || filteredBotOptions.some((bot) => bot.id === botId)) return filteredBotOptions;
    return [{ id: botId, name: selectedBot?.name ?? botId }, ...filteredBotOptions];
  }, [botId, filteredBotOptions, selectedBot?.name]);
  const activeBotOptionCount = visibleBotOptions.length + 1;
  const defaultActiveBotId =
    normalizedBotQuery && filteredBotOptions.length > 0 ? filteredBotOptions[0]?.id : botId;
  const defaultActiveBotIndex = defaultActiveBotId
    ? visibleBotOptions.findIndex((bot) => bot.id === defaultActiveBotId) + 1
    : 0;
  const safeActiveBotIndex =
    activeBotIndex < 0 ? defaultActiveBotIndex : Math.min(activeBotIndex, activeBotOptionCount - 1);

  useEffect(() => {
    if (!botPickerOpen) return;
    botPickerInputRef.current?.focus();
  }, [botPickerOpen]);

  useEffect(() => {
    if (!botPickerOpen || safeActiveBotIndex === 0) return;
    const option = document.getElementById(`${botListboxId}-${safeActiveBotIndex}`);
    const listbox = botListboxRef.current;
    if (!option || !listbox?.contains(option)) return;
    const optionBounds = option.getBoundingClientRect();
    const listboxBounds = listbox.getBoundingClientRect();
    const visibleTop = Math.max(
      listboxBounds.top,
      allBotsOptionRef.current?.getBoundingClientRect().bottom ?? listboxBounds.top,
    );
    if (optionBounds.top < visibleTop) listbox.scrollTop += optionBounds.top - visibleTop;
    else if (optionBounds.bottom > listboxBounds.bottom)
      listbox.scrollTop += optionBounds.bottom - listboxBounds.bottom;
  }, [botListboxId, botPickerOpen, safeActiveBotIndex, visibleBotOptions]);

  const closeBotPicker = (focusTarget: "trigger" | "chatId" = "trigger") => {
    setBotPickerOpen(false);
    setBotQuery("");
    setActiveBotIndex(-1);
    window.requestAnimationFrame(() =>
      document
        .getElementById(focusTarget === "chatId" ? "logs-chat-id-filter" : "logs-bot-filter")
        ?.focus(),
    );
  };

  const selectBot = (nextBotId: string) => {
    setSearchParams(nextBotId ? { botId: nextBotId } : {});
    closeBotPicker();
  };

  const retryBotOptions = (fromPicker: boolean) => {
    if (botOptionsLoading) return;
    retryInProgressRef.current = !fromPicker;
    if (fromPicker) botPickerInputRef.current?.focus();
    setBotOptionsLoading(true);
    setBotOptionsRetry((retry) => retry + 1);
  };

  const clearLogs = async () => {
    const selectedBotName = botOptions.find((bot) => bot.id === botId)?.name ?? botId;
    const confirmation = botId
      ? t("logs.clearBotConfirm", { botName: selectedBotName })
      : t("logs.clearConfirm");
    if (!window.confirm(confirmation)) return;
    setClearError(null);
    try {
      const response = await client.api.logs.$delete({ query: botId ? { botId } : {} });
      const body = await response.json();
      if (!response.ok || !body.ok) {
        setClearError(t("logs.clearFailed"));
        return;
      }
      clearLiveLogs();
      setPausedLiveLogs([]);
      setLivePaused(false);
      setPage(1);
      invalidate({ resource: "logs", invalidates: ["list"] });
    } catch {
      setClearError(t("logs.clearFailed"));
    }
  };

  const logs = data?.data ?? [];
  const visibleLiveLogs = useMemo(
    () =>
      (livePaused ? pausedLiveLogs : liveLogs).filter(
        (log) =>
          (!botId || log.botId === botId) &&
          logMatchesFilters(log, level, search, chatId, correlationId),
      ),
    [botId, chatId, correlationId, level, liveLogs, livePaused, pausedLiveLogs, search],
  );
  const visibleLogs = useMemo(
    () => (page === 1 ? mergeLogEntries(logs, visibleLiveLogs) : logs),
    [logs, page, visibleLiveLogs],
  );
  const total = data?.total ?? 0;
  const totalPages = Math.max(1, Math.ceil(total / 50));
  const labels: LogEntryLabels = {
    details: t("logs.details"),
    metadata: t("logs.metadata"),
    copyJson: t("logs.copyJson"),
    copied: t("logs.copied"),
  };

  const toggleLivePaused = () => {
    if (livePaused) {
      setLivePaused(false);
      setPausedLiveLogs([]);
      return;
    }
    setPausedLiveLogs(liveLogs);
    setLivePaused(true);
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h1 className="text-2xl font-bold">{t("logs.title")}</h1>
        <div className="flex flex-wrap items-center justify-end gap-2 sm:gap-3">
          <Button
            variant="destructive"
            size="sm"
            className="shrink-0 whitespace-nowrap"
            onClick={clearLogs}
          >
            <Trash2 className="mr-1 h-3.5 w-3.5" />
            {t("logs.clear")}
          </Button>
          <div className="flex shrink-0 items-center gap-2">
            <Radio className={connected ? "text-success size-4" : "text-muted-foreground size-4"} />
            <span className="text-muted-foreground shrink-0 text-xs whitespace-nowrap">
              {livePaused ? t("logs.paused") : connected ? t("logs.live") : t("logs.disconnected")}
            </span>
            <Button
              variant="outline"
              size="sm"
              className="shrink-0 whitespace-nowrap"
              onClick={toggleLivePaused}
            >
              {livePaused ? <Play className="size-3.5" /> : <Pause className="size-3.5" />}
              {livePaused ? t("logs.resumeLive") : t("logs.pauseLive")}
            </Button>
          </div>
        </div>
      </div>

      {/* Filters */}
      <div
        className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-[minmax(12rem,1.2fr)_7.5rem_10rem_9rem_minmax(12rem,1fr)]"
        data-testid="log-filters"
      >
        <div className="relative min-w-0">
          <Search className="text-muted-foreground pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2" />
          <Input
            className="w-full pl-8"
            maxLength={500}
            placeholder={t("logs.searchPlaceholder")}
            value={searchInput}
            onChange={(event) => setSearchInput(event.target.value)}
            onCompositionStart={() => {
              composingRef.current = true;
            }}
            onCompositionEnd={(event) => {
              composingRef.current = false;
              setSearch(event.currentTarget.value.trim());
              setPage(1);
            }}
            aria-label={t("logs.searchPlaceholder")}
          />
        </div>
        <Select
          className="w-full"
          value={level}
          onChange={(e) => {
            setLevel(e.target.value);
            setPage(1);
          }}
          aria-label={t("logs.allLevels")}
        >
          <option value="">{t("logs.allLevels")}</option>
          <option value="debug">Debug</option>
          <option value="info">Info</option>
          <option value="warn">Warn</option>
          <option value="error">Error</option>
        </Select>
        <Popover
          open={botPickerOpen}
          onOpenChange={(open) => {
            setBotPickerOpen(open);
            if (!open) {
              setBotQuery("");
              setActiveBotIndex(-1);
            }
          }}
          className="w-[min(24rem,calc(100vw-2rem))] p-2"
          trigger={
            <Button
              id="logs-bot-filter"
              type="button"
              variant="outline"
              aria-label={t("logs.botFilterLabel", {
                botName: botId ? (selectedBot?.name ?? botId) : t("logs.allBots"),
              })}
              aria-expanded={botPickerOpen}
              className="w-full min-w-0 justify-between px-3 font-normal"
            >
              <span className={botId ? "truncate" : "text-muted-foreground truncate"}>
                {botId ? (selectedBot?.name ?? botId) : t("logs.allBots")}
              </span>
              <ChevronDown className="text-muted-foreground size-4 shrink-0" aria-hidden="true" />
            </Button>
          }
        >
          <div className="relative mb-2">
            <Search
              className="text-muted-foreground pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2"
              aria-hidden="true"
            />
            <input
              ref={botPickerInputRef}
              autoFocus
              type="search"
              autoComplete="off"
              value={botQuery}
              onChange={(event) => {
                setBotQuery(event.target.value);
                setActiveBotIndex(-1);
              }}
              onKeyDown={(event) => {
                if (event.key === "Tab") {
                  event.preventDefault();
                  event.stopPropagation();
                  if (!event.shiftKey && botOptionsError && !botOptionsLoading) {
                    document.getElementById("logs-bot-options-retry-popover")?.focus();
                  } else {
                    closeBotPicker(event.shiftKey ? "trigger" : "chatId");
                  }
                  return;
                }
                if (event.nativeEvent.isComposing || event.keyCode === 229) return;
                if (event.key === "ArrowDown") {
                  event.preventDefault();
                  setActiveBotIndex(Math.min(safeActiveBotIndex + 1, activeBotOptionCount - 1));
                } else if (event.key === "ArrowUp") {
                  event.preventDefault();
                  setActiveBotIndex(Math.max(safeActiveBotIndex - 1, 0));
                } else if (event.key === "Enter") {
                  event.preventDefault();
                  if (safeActiveBotIndex === 0) selectBot("");
                  else {
                    const activeBot = visibleBotOptions[safeActiveBotIndex - 1];
                    if (activeBot) selectBot(activeBot.id);
                  }
                } else if (event.key === "Escape") {
                  event.preventDefault();
                  event.stopPropagation();
                  closeBotPicker();
                }
              }}
              className="focus-visible:border-primary focus-visible:ring-ring/20 border-input placeholder:text-muted-foreground h-10 w-full rounded-lg border bg-white pr-3 pl-9 text-sm shadow-sm outline-none focus-visible:ring-2"
              placeholder={t("logs.searchBots")}
              aria-label={t("logs.searchBots")}
              role="combobox"
              aria-autocomplete="list"
              aria-expanded="true"
              aria-controls={botListboxId}
              aria-activedescendant={`${botListboxId}-${safeActiveBotIndex}`}
            />
          </div>
          <div
            ref={botListboxRef}
            id={botListboxId}
            role="listbox"
            aria-label={t("logs.allBots")}
            className="max-h-64 space-y-1 overflow-y-auto"
          >
            <button
              ref={allBotsOptionRef}
              id={`${botListboxId}-0`}
              type="button"
              role="option"
              tabIndex={-1}
              aria-selected={!botId}
              onPointerMove={() => setActiveBotIndex(0)}
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => selectBot("")}
              className={`sticky top-0 z-10 flex w-full items-center justify-between gap-2 rounded-lg px-3 py-2 text-left text-sm ${safeActiveBotIndex === 0 ? "bg-accent" : "bg-popover hover:bg-accent"}`}
            >
              <span className="truncate">{t("logs.allBots")}</span>
              {!botId && <Check className="size-4 shrink-0" aria-hidden="true" />}
            </button>
            {botOptionsLoading ? (
              <p role="status" className="text-muted-foreground px-3 py-3 text-sm">
                {t("logs.botOptionsLoading")}
              </p>
            ) : botOptionsError ? (
              <div className="space-y-2 px-3 py-3">
                <p role="alert" className="text-destructive text-sm">
                  {t("logs.botOptionsLoadError")}
                </p>
                <Button
                  id="logs-bot-options-retry-popover"
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => retryBotOptions(true)}
                  onKeyDown={(event) => {
                    if (event.key !== "Tab") return;
                    event.preventDefault();
                    event.stopPropagation();
                    if (event.shiftKey) botPickerInputRef.current?.focus();
                    else closeBotPicker("chatId");
                  }}
                >
                  <RotateCw className="size-3.5" aria-hidden="true" />
                  {t("logs.retry")}
                </Button>
              </div>
            ) : filteredBotOptions.length === 0 ? (
              <p role="status" className="text-muted-foreground px-3 py-3 text-sm">
                {t("logs.noBotsFound")}
              </p>
            ) : null}
            {visibleBotOptions.map((bot, index) => (
              <button
                key={bot.id}
                id={`${botListboxId}-${index + 1}`}
                type="button"
                role="option"
                tabIndex={-1}
                aria-selected={bot.id === botId}
                onPointerMove={() => setActiveBotIndex(index + 1)}
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => selectBot(bot.id)}
                className={`hover:bg-accent flex w-full items-center justify-between gap-2 rounded-lg px-3 py-2 text-left text-sm ${safeActiveBotIndex === index + 1 ? "bg-accent" : ""}`}
              >
                <span className="truncate">{bot.name}</span>
                {bot.id === botId && <Check className="size-4 shrink-0" aria-hidden="true" />}
              </button>
            ))}
          </div>
        </Popover>
        <Input
          id="logs-chat-id-filter"
          className="w-full font-mono"
          inputMode="numeric"
          maxLength={32}
          placeholder={t("logs.chatIdPlaceholder")}
          value={chatIdInput}
          onChange={(event) => {
            const nextValue = event.target.value;
            if (!/^-?\d*$/.test(nextValue)) return;
            setChatIdInput(nextValue);
            setChatId(nextValue === "-" ? "" : nextValue);
            setPage(1);
          }}
          aria-label={t("logs.chatIdPlaceholder")}
        />
        <Input
          className="w-full min-w-0 font-mono"
          maxLength={200}
          placeholder={t("logs.correlationIdPlaceholder")}
          value={correlationIdInput}
          onChange={(event) => {
            setCorrelationIdInput(event.target.value);
            setCorrelationId(event.target.value.trim());
            setPage(1);
          }}
          aria-label={t("logs.correlationIdPlaceholder")}
        />
      </div>

      {botOptionsError && (
        <div
          role={botOptionsLoading ? "status" : "alert"}
          aria-live="polite"
          className="border-danger-border bg-danger-soft text-destructive flex items-center gap-3 rounded-md border p-3 text-sm"
        >
          <AlertCircle className="size-4 shrink-0" aria-hidden="true" />
          <span className="flex-1">
            {t(botOptionsLoading ? "logs.botOptionsLoading" : "logs.botOptionsLoadError")}
          </span>
          <Button
            id="logs-bot-options-retry"
            variant="outline"
            size="sm"
            aria-disabled={botOptionsLoading}
            className="shrink-0 aria-disabled:cursor-wait aria-disabled:opacity-60"
            onClick={() => retryBotOptions(false)}
          >
            <RotateCw className={`size-3.5 ${botOptionsLoading ? "animate-spin" : ""}`} />
            {t(botOptionsLoading ? "logs.loading" : "logs.retry")}
          </Button>
        </div>
      )}

      {clearError && (
        <p className="text-destructive text-sm" role="alert">
          {clearError}
        </p>
      )}

      {/* Log list */}
      <Card>
        <CardContent className="p-0">
          {isLoading ? (
            <p className="text-muted-foreground p-6 text-sm">{t("logs.loading")}</p>
          ) : isError ? (
            <div role="alert" className="text-destructive flex items-center gap-3 p-6 text-sm">
              <AlertCircle className="size-4 shrink-0" aria-hidden="true" />
              <span className="flex-1">{t("logs.loadError")}</span>
              <Button variant="outline" size="sm" onClick={() => void refetch()}>
                <RotateCw className="size-3.5" />
                {t("logs.retry")}
              </Button>
            </div>
          ) : visibleLogs.length === 0 ? (
            <p className="text-muted-foreground p-6 text-sm">{t("logs.empty")}</p>
          ) : (
            <div className="divide-y">
              {visibleLogs.map((log) => (
                <LogEntryRow
                  key={log.id}
                  log={log}
                  locale={i18n.resolvedLanguage}
                  labels={labels}
                  showBotId={!botId}
                  live={visibleLiveLogs.some((liveLog) => liveLog.id === log.id)}
                />
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Pagination */}
      <Pagination page={page} totalPages={totalPages} onPageChange={setPage} />
    </div>
  );
}
