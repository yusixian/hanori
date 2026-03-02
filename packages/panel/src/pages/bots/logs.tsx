import { LogMetaDisplay, formatTime, levelBadge } from "@/components/logs/log-meta-display";
import type { LogMeta } from "@/components/logs/log-meta-display";
import { Pagination } from "@/components/ui/pagination";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { useSSEConnection } from "@/hooks/use-sse-connection";
import { client } from "@/lib/client";
import { cn } from "@/lib/utils";
import type { LogEntry } from "@cos-tool-bot/shared";
import { useInvalidate, useList } from "@refinedev/core";
import { Radio, Search, Trash2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useParams } from "react-router";

export function BotLogsPage() {
  const { botId } = useParams<{ botId: string }>();
  const [page, setPage] = useState(1);
  const [level, setLevel] = useState("");
  const [searchInput, setSearchInput] = useState("");
  const [search, setSearch] = useState("");
  const debounceRef = useRef<ReturnType<typeof setTimeout>>(null);

  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      setSearch(searchInput);
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

  const { data, isLoading } = useList<LogEntry>({
    resource: "logs",
    pagination: { current: page, pageSize: 50 },
    filters,
  });

  const invalidate = useInvalidate();

  const clearLogs = async () => {
    if (!window.confirm("确认清空该 Bot 的所有日志？")) return;
    await client.api.logs.$delete({ query: { botId: botId! } });
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
              className={cn("h-4 w-4", connected ? "text-emerald-400" : "text-muted-foreground")}
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
        <div className="relative">
          <Search className="text-muted-foreground pointer-events-none absolute top-1/2 left-2.5 h-4 w-4 -translate-y-1/2" />
          <Input
            className="w-56 pl-8"
            placeholder="搜索日志..."
            value={searchInput}
            onChange={(e) => setSearchInput(e.target.value)}
          />
        </div>
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
