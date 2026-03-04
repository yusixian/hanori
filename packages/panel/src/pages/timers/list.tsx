import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Select } from "@/components/ui/select";
import { client } from "@/lib/client";
import { formatDuration } from "@cos-tool-bot/shared";
import type { TimerRecord } from "@cos-tool-bot/shared";
import { RefreshCw, Timer, Trash2 } from "lucide-react";
import { useCallback, useEffect, useState } from "react";

function formatRemaining(firesAt: string | null): string {
  if (!firesAt) return "—";
  const remaining = new Date(firesAt).getTime() - Date.now();
  if (remaining <= 0) return "即将触发";
  return formatDuration(remaining);
}

export function TimersListPage() {
  const [timers, setTimers] = useState<TimerRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [typeFilter, setTypeFilter] = useState<string>("");

  const fetchTimers = useCallback(async () => {
    try {
      const query: Record<string, string> = {};
      if (typeFilter) query.type = typeFilter;
      const res = await client.api.timers.$get({ query });
      const json = await res.json();
      if (json.ok) {
        setTimers(json.data);
      }
    } catch (err) {
      console.error("Failed to fetch timers", err);
    } finally {
      setLoading(false);
    }
  }, [typeFilter]);

  useEffect(() => {
    fetchTimers();
    const interval = setInterval(fetchTimers, 10_000);
    return () => clearInterval(interval);
  }, [fetchTimers]);

  const cancelTimer = async (timerId: string) => {
    if (!window.confirm(`确认取消定时器 ${timerId}？`)) return;
    try {
      await client.api.timers[":timerId"].$delete({ param: { timerId } });
      await fetchTimers();
    } catch (err) {
      console.error("Failed to cancel timer", err);
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <Timer className="text-primary h-6 w-6" />
          <h1 className="text-2xl font-bold">Timers</h1>
          <Badge variant="muted">{timers.length} active</Badge>
        </div>
        <Button variant="outline" size="sm" onClick={fetchTimers}>
          <RefreshCw className="mr-1 h-3.5 w-3.5" />
          Refresh
        </Button>
      </div>

      {/* Filters */}
      <div className="flex items-center gap-3">
        <Select value={typeFilter} onChange={(e) => setTypeFilter(e.target.value)}>
          <option value="">All Types</option>
          <option value="ai">AI Timers</option>
          <option value="system">System Timers</option>
        </Select>
      </div>

      {/* Timer list */}
      <Card>
        <CardContent className="p-0">
          {loading ? (
            <p className="text-muted-foreground p-6 text-sm">Loading...</p>
          ) : timers.length === 0 ? (
            <p className="text-muted-foreground p-6 text-sm">No active timers</p>
          ) : (
            <div className="divide-y">
              {timers.map((timer) => (
                <div key={timer.id} className="flex items-center gap-3 px-4 py-3">
                  <Badge variant={timer.type === "ai" ? "default" : "muted"}>
                    {timer.type === "ai" ? "🤖 AI" : "🔧 System"}
                  </Badge>
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium">{timer.name}</p>
                    <div className="text-muted-foreground flex flex-wrap gap-3 text-xs">
                      <span>ID: {timer.id}</span>
                      {timer.chatId && <span>Chat: {timer.chatId}</span>}
                      {timer.intervalMs && (
                        <span>Interval: {formatDuration(timer.intervalMs)}</span>
                      )}
                      {timer.firesAt && <span>Fires in: {formatRemaining(timer.firesAt)}</span>}
                    </div>
                  </div>
                  {timer.type === "ai" && (
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => cancelTimer(timer.id)}
                      title="Cancel timer"
                    >
                      <Trash2 className="h-4 w-4 text-red-500" />
                    </Button>
                  )}
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
