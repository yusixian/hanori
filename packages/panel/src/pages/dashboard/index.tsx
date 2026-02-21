import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { client } from "@/lib/client";
import type { BotStatus } from "@cos-tool-bot/shared";
import { Play, RefreshCw, Square } from "lucide-react";
import { useCallback, useEffect, useState } from "react";

function formatUptime(ms: number | null): string {
  if (ms == null) return "-";
  const seconds = Math.floor(ms / 1000);
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  return `${h}h ${m}m ${s}s`;
}

const statusBadge: Record<BotStatus, { label: string; variant: "success" | "destructive" | "warning" }> = {
  running: { label: "Running", variant: "success" },
  stopped: { label: "Stopped", variant: "destructive" },
  restarting: { label: "Restarting", variant: "warning" },
};

interface StatusData {
  status: BotStatus;
  uptime: number | null;
}

export function DashboardPage() {
  const [status, setStatus] = useState<StatusData | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);

  const fetchStatus = useCallback(async () => {
    try {
      const res = await client.api.bot.status.$get();
      const json = await res.json();
      if (json.ok) setStatus(json.data);
    } catch { /* ignore */ }
    finally { setLoading(false); }
  }, []);

  useEffect(() => {
    fetchStatus();
    const interval = setInterval(fetchStatus, 5000);
    return () => clearInterval(interval);
  }, [fetchStatus]);

  const action = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    try {
      await fn();
      await fetchStatus();
    } finally {
      setBusy(false);
    }
  };

  const isRunning = status?.status === "running";

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold">Dashboard</h1>

      <div className="grid gap-4 md:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Bot Status</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            {loading ? (
              <p className="text-sm text-muted-foreground">Loading...</p>
            ) : status ? (
              <>
                <div className="flex items-center gap-2">
                  <span className="text-sm text-muted-foreground">Status:</span>
                  <Badge variant={statusBadge[status.status].variant}>
                    {statusBadge[status.status].label}
                  </Badge>
                </div>
                <div className="flex items-center gap-2">
                  <span className="text-sm text-muted-foreground">Uptime:</span>
                  <span className="text-sm font-mono">{formatUptime(status.uptime)}</span>
                </div>
              </>
            ) : (
              <p className="text-sm text-muted-foreground">Unable to fetch status</p>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">Controls</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="flex flex-wrap gap-2">
              <Button size="sm" disabled={isRunning || busy} onClick={() => action(() => client.api.bot.start.$post())}>
                <Play className="h-4 w-4" />
                Start
              </Button>
              <Button size="sm" variant="destructive" disabled={!isRunning || busy} onClick={() => action(() => client.api.bot.stop.$post())}>
                <Square className="h-4 w-4" />
                Stop
              </Button>
              <Button size="sm" variant="outline" disabled={!isRunning || busy} onClick={() => action(() => client.api.bot.restart.$post())}>
                <RefreshCw className="h-4 w-4" />
                Restart
              </Button>
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
