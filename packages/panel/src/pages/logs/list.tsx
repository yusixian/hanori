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

export function LogsListPage() {
  const { t, i18n } = useTranslation("admin");
  const [searchParams, setSearchParams] = useSearchParams();
  const [page, setPage] = useState(1);
  const [level, setLevel] = useState("");
  const [botId, setBotId] = useState(searchParams.get("botId") ?? "");
  const [botOptions, setBotOptions] = useState<BotWithStatus[]>([]);
  const [searchInput, setSearchInput] = useState("");
  const [search, setSearch] = useState("");
  const [chatId, setChatId] = useState("");
  const [correlationId, setCorrelationId] = useState("");
  const composingRef = useRef(false);
  const [livePaused, setLivePaused] = useState(false);
  const [pausedLiveLogs, setPausedLiveLogs] = useState<LogEntry[]>([]);

  const sseUrl = useMemo(
    () => (botId ? `/api/logs/stream?botId=${botId}` : "/api/logs/stream"),
    [botId],
  );
  const { connected, liveLogs, clearLiveLogs } = useSSEConnection(sseUrl);

  // Fetch bot options for filter
  useEffect(() => {
    client.api.bots
      .$get({ query: { page: "1", limit: "100" } })
      .then((res) => res.json())
      .then((json) => {
        if (json.ok) setBotOptions(json.data as BotWithStatus[]);
      })
      .catch((err) => console.error("Failed to fetch bot options", err));
  }, []);

  useEffect(() => {
    if (composingRef.current) return;
    const timeout = window.setTimeout(() => {
      setSearch(searchInput);
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
    if (!window.confirm(t("logs.clearConfirm"))) return;
    await client.api.logs.$delete({ query: botId ? { botId } : {} });
    clearLiveLogs();
    setPausedLiveLogs([]);
    setLivePaused(false);
    setPage(1);
    invalidate({ resource: "logs", invalidates: ["list"] });
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
      <div className="flex flex-wrap items-center gap-3">
        <div className="relative">
          <Search className="text-muted-foreground pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2" />
          <Input
            className="w-56 pl-8"
            placeholder={t("logs.searchPlaceholder")}
            value={searchInput}
            onChange={(event) => setSearchInput(event.target.value)}
            onCompositionStart={() => {
              composingRef.current = true;
            }}
            onCompositionEnd={(event) => {
              composingRef.current = false;
              setSearch(event.currentTarget.value);
              setPage(1);
            }}
            aria-label={t("logs.searchPlaceholder")}
          />
        </div>
        <Select
          value={level}
          onChange={(e) => {
            setLevel(e.target.value);
            setPage(1);
          }}
        >
          <option value="">{t("logs.allLevels")}</option>
          <option value="debug">Debug</option>
          <option value="info">Info</option>
          <option value="warn">Warn</option>
          <option value="error">Error</option>
        </Select>
        <Select
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
        >
          <option value="">{t("logs.allBots")}</option>
          {botOptions.map((bot) => (
            <option key={bot.id} value={bot.id}>
              {bot.name}
            </option>
          ))}
        </Select>
        <Input
          className="w-44 font-mono"
          inputMode="numeric"
          placeholder={t("logs.chatIdPlaceholder")}
          value={chatId}
          onChange={(event) => {
            setChatId(event.target.value);
            setPage(1);
          }}
          aria-label={t("logs.chatIdPlaceholder")}
        />
        <Input
          className="min-w-56 flex-1 font-mono"
          placeholder={t("logs.correlationIdPlaceholder")}
          value={correlationId}
          onChange={(event) => {
            setCorrelationId(event.target.value);
            setPage(1);
          }}
          aria-label={t("logs.correlationIdPlaceholder")}
        />
      </div>

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
