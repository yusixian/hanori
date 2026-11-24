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
import type { LogEntry } from "@cos-tool-bot/shared";
import { useInvalidate, useList } from "@refinedev/core";
import { AlertCircle, Pause, Play, Radio, RotateCw, Search, Trash2 } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { useParams } from "react-router";
import { useTranslation } from "react-i18next";

export function BotLogsPage() {
  const { t } = useTranslation("bots");
  const { botId } = useParams<{ botId: string }>();
  const [page, setPage] = useState(1);
  const [level, setLevel] = useState("");
  const [searchInput, setSearchInput] = useState("");
  const [search, setSearch] = useState("");
  const [chatIdInput, setChatIdInput] = useState("");
  const [chatId, setChatId] = useState("");
  const [correlationIdInput, setCorrelationIdInput] = useState("");
  const [correlationId, setCorrelationId] = useState("");
  const [clearError, setClearError] = useState<string | null>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout>>(null);
  const composingRef = useRef(false);
  const [livePaused, setLivePaused] = useState(false);
  const [pausedLiveLogs, setPausedLiveLogs] = useState<LogEntry[]>([]);

  useEffect(() => {
    if (composingRef.current) return;
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      setSearch(searchInput.trim());
      setPage(1);
    }, 300);
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [searchInput]);

  const { connected, liveLogs, clearLiveLogs } = useSSEConnection(
    `/api/logs/stream?botId=${botId}`,
  );

  const filters = [{ field: "botId", operator: "eq" as const, value: botId! }];
  if (level) filters.push({ field: "level", operator: "eq" as const, value: level });
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
    if (!window.confirm(t("logs.confirmClear"))) return;
    setClearError(null);
    try {
      const response = await client.api.logs.$delete({ query: { botId: botId! } });
      const body = await response.json();
      if (!response.ok || !body.ok) {
        setClearError(t("admin:logs.clearFailed"));
        return;
      }
      clearLiveLogs();
      setPausedLiveLogs([]);
      setLivePaused(false);
      setPage(1);
      invalidate({ resource: "logs", invalidates: ["list"] });
    } catch {
      setClearError(t("admin:logs.clearFailed"));
    }
  };

  const logs = data?.data ?? [];
  const visibleLiveLogs = useMemo(
    () =>
      (livePaused ? pausedLiveLogs : liveLogs).filter(
        (log) =>
          log.botId === botId && logMatchesFilters(log, level, search, chatId, correlationId),
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
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h1 className="text-2xl font-bold">{t("logs.title")}</h1>
        <div className="flex flex-wrap items-center justify-end gap-2 sm:gap-3">
          <Button
            variant="ghost"
            size="sm"
            className="text-destructive shrink-0 whitespace-nowrap"
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
        className="grid grid-cols-1 gap-2 sm:grid-cols-2 xl:grid-cols-[minmax(14rem,1.2fr)_9rem_11rem_minmax(14rem,1fr)]"
        data-testid="log-filters"
      >
        <div className="relative min-w-0">
          <Search className="text-muted-foreground pointer-events-none absolute top-1/2 left-2.5 h-4 w-4 -translate-y-1/2" />
          <Input
            className="w-full pl-8"
            maxLength={500}
            placeholder={t("logs.searchPlaceholder")}
            value={searchInput}
            onChange={(e) => setSearchInput(e.target.value)}
            onCompositionStart={() => {
              composingRef.current = true;
            }}
            onCompositionEnd={(e) => {
              composingRef.current = false;
              setSearch(e.currentTarget.value.trim());
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

      {clearError && (
        <p className="text-destructive text-sm" role="alert">
          {clearError}
        </p>
      )}

      {/* Log list */}
      <Card>
        <CardContent className="overflow-hidden rounded-[inherit] p-0 sm:p-0">
          {isLoading ? (
            <p className="text-muted-foreground p-6 text-sm">{t("common:common.loading")}</p>
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
                  labels={labels}
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
