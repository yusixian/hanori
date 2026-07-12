import { LogMetaDisplay, formatTime, levelBadge } from "@/components/logs/log-meta-display";
import type { LogMeta } from "@/components/logs/log-meta-display";
import { Pagination } from "@/components/ui/pagination";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Select } from "@/components/ui/select";
import { useSSEConnection } from "@/hooks/use-sse-connection";
import { client } from "@/lib/client";
import { cn } from "@/lib/utils";
import type { BotWithStatus, LogEntry } from "@cos-tool-bot/shared";
import { useInvalidate, useList } from "@refinedev/core";
import { Radio, Trash2 } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { useSearchParams } from "react-router";

export function LogsListPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const [page, setPage] = useState(1);
  const [level, setLevel] = useState("");
  const [botId, setBotId] = useState(searchParams.get("botId") ?? "");
  const [botOptions, setBotOptions] = useState<BotWithStatus[]>([]);

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

  const filters = [];
  if (level) filters.push({ field: "level", operator: "eq" as const, value: level });
  if (botId) filters.push({ field: "botId", operator: "eq" as const, value: botId });

  const { data, isLoading } = useList<LogEntry>({
    resource: "logs",
    pagination: { current: page, pageSize: 50 },
    filters,
  });

  const invalidate = useInvalidate();

  const clearLogs = async () => {
    if (!window.confirm("确认清空所有日志？")) return;
    await client.api.logs.$delete({ query: botId ? { botId } : {} });
    clearLiveLogs();
    setPage(1);
    invalidate({ resource: "logs", invalidates: ["list"] });
  };

  const logs = data?.data ?? [];
  const total = data?.total ?? 0;
  const totalPages = Math.max(1, Math.ceil(total / 50));

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h1 className="text-2xl font-bold">Logs</h1>
        <div className="flex items-center gap-3">
          <Button variant="destructive" size="sm" onClick={clearLogs}>
            <Trash2 className="mr-1 h-3.5 w-3.5" />
            Clear Logs
          </Button>
          <div className="flex items-center gap-2">
            <Radio
              className={cn("h-4 w-4", connected ? "text-emerald-600" : "text-muted-foreground")}
            />
            <span className="text-muted-foreground text-xs">
              {connected ? "Live" : "Disconnected"}
            </span>
          </div>
        </div>
      </div>

      {/* Live logs */}
      {liveLogs.length > 0 && (
        <Card>
          <CardHeader className="py-3">
            <CardTitle className="text-muted-foreground text-sm font-medium">Real-time</CardTitle>
          </CardHeader>
          <CardContent className="space-y-1 pt-0">
            {liveLogs.slice(0, 5).map((log) => (
              <div
                key={log.id}
                className="border-primary/20 bg-primary/5 animate-in fade-in rounded border p-2 text-xs"
              >
                <div className="flex items-center gap-2">
                  <Badge variant={levelBadge[log.level] ?? "muted"} className="shrink-0">
                    {log.level}
                  </Badge>
                  <span className="min-w-0 flex-1 truncate font-mono">{log.message}</span>
                  <span className="text-muted-foreground shrink-0">
                    {formatTime(log.createdAt)}
                  </span>
                </div>
                <LogMetaDisplay meta={log.meta as LogMeta} />
              </div>
            ))}
          </CardContent>
        </Card>
      )}

      {/* Filters */}
      <div className="flex flex-wrap items-center gap-3">
        <Select
          value={level}
          onChange={(e) => {
            setLevel(e.target.value);
            setPage(1);
          }}
        >
          <option value="">All Levels</option>
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
            if (e.target.value) {
              setSearchParams({ botId: e.target.value });
            } else {
              setSearchParams({});
            }
          }}
        >
          <option value="">All Bots</option>
          {botOptions.map((bot) => (
            <option key={bot.id} value={bot.id}>
              {bot.name}
            </option>
          ))}
        </Select>
      </div>

      {/* Log list */}
      <Card>
        <CardContent className="p-0">
          {isLoading ? (
            <p className="text-muted-foreground p-6 text-sm">Loading...</p>
          ) : logs.length === 0 ? (
            <p className="text-muted-foreground p-6 text-sm">No logs found</p>
          ) : (
            <div className="divide-y">
              {logs.map((log) => (
                <div key={log.id} className="px-4 py-3">
                  <div className="flex items-center gap-3">
                    <Badge variant={levelBadge[log.level] ?? "muted"} className="shrink-0">
                      {log.level}
                    </Badge>
                    <p className="min-w-0 flex-1 truncate font-mono text-sm" title={log.message}>
                      {log.message}
                    </p>
                    <span className="text-muted-foreground shrink-0 text-xs">
                      {formatTime(log.createdAt)}
                    </span>
                  </div>
                  <LogMetaDisplay meta={log.meta as LogMeta} />
                </div>
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
