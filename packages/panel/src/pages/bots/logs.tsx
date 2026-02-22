import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Select } from "@/components/ui/select";
import { client } from "@/lib/client";
import type { LogEntry } from "@cos-tool-bot/shared";
import { useInvalidate, useList } from "@refinedev/core";
import { ChevronLeft, ChevronRight, Radio, Trash2 } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { collapseAllNested, darkStyles, JsonView } from "react-json-view-lite";
import "react-json-view-lite/dist/index.css";
import { useParams } from "react-router";

type LogMeta = Record<string, unknown> | null | undefined;

function isComplexValue(value: unknown): value is object {
  return typeof value === "object" && value !== null;
}

function LogMetaDisplay({ meta }: { meta: LogMeta }) {
  if (!meta || typeof meta !== "object") return null;
  const entries = Object.entries(meta).filter(([, v]) => v != null && v !== "");
  if (entries.length === 0) return null;

  const simple = entries.filter(([, v]) => !isComplexValue(v));
  const complex = entries.filter(([, v]) => isComplexValue(v));

  return (
    <div className="mt-1 space-y-1">
      {simple.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {simple.map(([key, value]) => (
            <span
              key={key}
              className="bg-muted text-muted-foreground inline-flex items-center gap-1 rounded px-1.5 py-0.5 font-mono text-[11px]"
            >
              <span className="text-primary/70">{key}:</span>
              <span className="max-w-[300px] truncate">{String(value)}</span>
            </span>
          ))}
        </div>
      )}
      {complex.map(([key, value]) => (
        <div key={key} className="bg-muted/50 rounded px-2 py-1 font-mono text-[11px]">
          <span className="text-primary/70 mr-1">{key}:</span>
          <JsonView
            data={value as object}
            style={darkStyles}
            shouldExpandNode={collapseAllNested}
          />
        </div>
      ))}
    </div>
  );
}

const levelBadge: Record<string, "default" | "success" | "warning" | "destructive"> = {
  debug: "default",
  info: "success",
  warn: "warning",
  error: "destructive",
};

export function BotLogsPage() {
  const { botId } = useParams<{ botId: string }>();
  const [page, setPage] = useState(1);
  const [level, setLevel] = useState("");
  const [sseConnected, setSseConnected] = useState(false);
  const [liveLogs, setLiveLogs] = useState<LogEntry[]>([]);
  const abortRef = useRef<AbortController | null>(null);

  const filters = [{ field: "botId", operator: "eq" as const, value: botId! }];
  if (level) filters.push({ field: "level", operator: "eq" as const, value: level });

  const { data, isLoading } = useList<LogEntry>({
    resource: "logs",
    pagination: { current: page, pageSize: 50 },
    filters,
  });

  const invalidate = useInvalidate();

  const clearLogs = async () => {
    if (!window.confirm("确认清空该 Bot 的所有日志？")) return;
    await client.api.logs.$delete({ query: { botId: botId! } });
    setLiveLogs([]);
    setPage(1);
    invalidate({ resource: "logs", invalidates: ["list"] });
  };

  const logs = data?.data ?? [];
  const total = data?.total ?? 0;
  const totalPages = Math.max(1, Math.ceil(total / 50));

  // SSE real-time streaming
  const connectSSE = useCallback(() => {
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    const token = localStorage.getItem("token");
    fetch(`/api/logs/stream?botId=${botId}`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: controller.signal,
    })
      .then(async (res) => {
        if (!res.ok || !res.body) return;
        setSseConnected(true);

        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split("\n");
          buffer = lines.pop() ?? "";

          for (const line of lines) {
            if (line.startsWith("data:")) {
              try {
                const entry = JSON.parse(line.slice(5).trim()) as LogEntry;
                setLiveLogs((prev) => [entry, ...prev].slice(0, 20));
              } catch {
                /* ignore parse errors */
              }
            }
          }
        }
      })
      .catch(() => {
        /* aborted or network error */
      })
      .finally(() => setSseConnected(false));
  }, [botId]);

  useEffect(() => {
    connectSSE();
    return () => abortRef.current?.abort();
  }, [connectSSE]);

  const formatTime = (iso: string) => {
    const d = new Date(iso);
    return d.toLocaleString("zh-CN", { hour12: false });
  };

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
              className={`h-4 w-4 ${sseConnected ? "text-emerald-400" : "text-muted-foreground"}`}
            />
            <span className="text-muted-foreground text-xs">
              {sseConnected ? "Live" : "Disconnected"}
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
      {totalPages > 1 && (
        <div className="flex items-center justify-center gap-2">
          <Button
            variant="outline"
            size="sm"
            disabled={page <= 1}
            onClick={() => setPage((p) => p - 1)}
          >
            <ChevronLeft className="h-4 w-4" />
          </Button>
          <span className="text-muted-foreground text-sm">
            {page} / {totalPages}
          </span>
          <Button
            variant="outline"
            size="sm"
            disabled={page >= totalPages}
            onClick={() => setPage((p) => p + 1)}
          >
            <ChevronRight className="h-4 w-4" />
          </Button>
        </div>
      )}
    </div>
  );
}
