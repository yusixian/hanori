import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Select } from "@/components/ui/select";
import { client } from "@/lib/client";
import { formatDuration } from "@cos-tool-bot/shared";
import type { TimerRecord } from "@cos-tool-bot/shared";
import { Bot, RefreshCw, Settings2, Timer, Trash2 } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

function formatRemaining(firesAt: string | null, firingSoonLabel: string): string {
  if (!firesAt) return "—";
  const remaining = new Date(firesAt).getTime() - Date.now();
  if (remaining <= 0) return firingSoonLabel;
  return formatDuration(remaining);
}

export function TimersListPage() {
  const { t } = useTranslation("admin");
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
    if (!window.confirm(t("timers.cancelConfirm", { id: timerId }))) return;
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
          <h1 className="text-2xl font-bold">{t("timers.title")}</h1>
          <Badge variant="muted">{t("timers.active", { count: timers.length })}</Badge>
        </div>
        <Button variant="outline" size="sm" onClick={fetchTimers}>
          <RefreshCw className="mr-1 h-3.5 w-3.5" />
          {t("timers.refresh")}
        </Button>
      </div>

      {/* Filters */}
      <div className="flex items-center gap-3">
        <Select value={typeFilter} onChange={(e) => setTypeFilter(e.target.value)}>
          <option value="">{t("timers.allTypes")}</option>
          <option value="ai">{t("timers.aiTimers")}</option>
          <option value="system">{t("timers.systemTimers")}</option>
        </Select>
      </div>

      {/* Timer list */}
      <Card className="overflow-hidden">
        <CardContent className="p-0">
          {loading ? (
            <p className="text-muted-foreground p-6 text-sm">{t("timers.loading")}</p>
          ) : timers.length === 0 ? (
            <p className="text-muted-foreground p-6 text-sm">{t("timers.empty")}</p>
          ) : (
            <div>
              <div className="text-muted-foreground bg-background/80 hidden grid-cols-[120px_minmax(0,1fr)_180px_160px_40px] gap-4 px-5 py-2.5 text-[11px] font-bold tracking-[0.08em] uppercase md:grid">
                <span>{t("timers.type")}</span>
                <span>{t("timers.timer")}</span>
                <span>{t("timers.schedule")}</span>
                <span>{t("timers.nextRun")}</span>
                <span className="sr-only">{t("timers.action")}</span>
              </div>
              {timers.map((timer) => (
                <div
                  key={timer.id}
                  className="border-border grid gap-3 border-t px-5 py-4 first:border-t-0 md:grid-cols-[120px_minmax(0,1fr)_180px_160px_40px] md:items-center md:gap-4"
                >
                  <Badge
                    variant={timer.type === "ai" ? "default" : "muted"}
                    className="w-fit gap-1.5"
                  >
                    {timer.type === "ai" ? (
                      <Bot className="size-3" />
                    ) : (
                      <Settings2 className="size-3" />
                    )}
                    {timer.type === "ai" ? t("timers.ai") : t("timers.system")}
                  </Badge>
                  <div className="min-w-0">
                    <p className="text-foreground truncate text-sm font-semibold">{timer.name}</p>
                    <p className="text-muted-foreground mt-0.5 truncate font-mono text-xs">
                      {timer.id}
                    </p>
                  </div>
                  <div className="text-foreground text-sm tabular-nums">
                    <span className="text-muted-foreground mr-2 md:hidden">
                      {t("timers.schedule")}
                    </span>
                    {timer.intervalMs
                      ? t("timers.every", { duration: formatDuration(timer.intervalMs) })
                      : t("timers.oneTime")}
                  </div>
                  <div className="text-foreground text-sm tabular-nums">
                    <span className="text-muted-foreground mr-2 md:hidden">
                      {t("timers.nextRun")}
                    </span>
                    {timer.firesAt ? formatRemaining(timer.firesAt, t("timers.firingSoon")) : "—"}
                  </div>
                  {timer.type === "ai" && (
                    <Button
                      variant="ghost"
                      size="icon"
                      onClick={() => cancelTimer(timer.id)}
                      title={t("timers.cancel")}
                      aria-label={t("timers.cancelNamed", { name: timer.name })}
                      className="text-destructive hover:bg-danger-soft hover:text-destructive justify-self-end"
                    >
                      <Trash2 className="h-4 w-4" />
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
