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
import { Select } from "@/components/ui/select";
import { useSSEConnection } from "@/hooks/use-sse-connection";
import { client } from "@/lib/client";
import type { BotWithStatus, LogEntry } from "@cos-tool-bot/shared";
import { useInvalidate, useList } from "@refinedev/core";
import { AlertCircle, Pause, Play, Radio, RotateCw, Search, Trash2 } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
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
  const [botId, setBotId] = useState(searchParams.get("botId") ?? "");
  const [botOptions, setBotOptions] = useState<BotWithStatus[]>([]);
  const [botOptionsError, setBotOptionsError] = useState(false);
  const [botOptionsRetry, setBotOptionsRetry] = useState(0);
  const [botOptionsLoading, setBotOptionsLoading] = useState(false);
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
            <Radio
              className={connected ? "size-4 text-emerald-600" : "text-muted-foreground size-4"}
            />
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
        <Select
          id="logs-bot-filter"
          className="w-full"
          value={botId}
          onChange={(e) => {
            setBotId(e.target.value);
            setPage(1);
            clearLiveLogs();
            setPausedLiveLogs([]);
            setLivePaused(false);
            if (e.target.value) {
              setSearchParams({ botId: e.target.value });
            } else {
              setSearchParams({});
            }
          }}
          aria-label={t("logs.allBots")}
        >
          <option value="">{t("logs.allBots")}</option>
          {botId && !botOptions.some((bot) => bot.id === botId) && (
            <option value={botId}>{botId}</option>
          )}
          {botOptions.map((bot) => (
            <option key={bot.id} value={bot.id}>
              {bot.name}
            </option>
          ))}
        </Select>
        <Input
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
          className="flex items-center gap-3 rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-800"
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
            onClick={() => {
              if (botOptionsLoading) return;
              retryInProgressRef.current = true;
              setBotOptionsLoading(true);
              setBotOptionsRetry((retry) => retry + 1);
            }}
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
            <div role="alert" className="flex items-center gap-3 p-6 text-sm text-red-700">
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
