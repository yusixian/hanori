import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { formatUptime, statusBadge } from "@/lib/bot-utils";
import { client } from "@/lib/client";
import type { BotWithStatus } from "@cos-tool-bot/shared";
import { ArrowLeft, Pencil, Play, RefreshCw, ScrollText, Square, Trash2 } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { Link, useNavigate, useParams } from "react-router";

export function BotDashboardPage() {
  const { botId } = useParams<{ botId: string }>();
  const navigate = useNavigate();
  const [bot, setBot] = useState<BotWithStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout>>(undefined);

  const fetchBot = useCallback(async () => {
    if (!botId) return;
    try {
      const res = await client.api.bots[":botId"].$get({ param: { botId } });
      const json = await res.json();
      if (json.ok) setBot(json.data as BotWithStatus);
    } catch (err) {
      console.error("Failed to fetch bot", err);
    } finally {
      setLoading(false);
    }
  }, [botId]);

  useEffect(() => {
    let cancelled = false;
    const poll = async () => {
      await fetchBot();
      if (!cancelled) timerRef.current = setTimeout(poll, 5000);
    };
    poll();
    return () => {
      cancelled = true;
      clearTimeout(timerRef.current);
    };
  }, [fetchBot]);

  const action = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    try {
      await fn();
      await fetchBot();
    } finally {
      setBusy(false);
    }
  };

  const handleDelete = async () => {
    if (!botId || !window.confirm("Are you sure you want to delete this bot?")) return;
    await client.api.bots[":botId"].$delete({ param: { botId } });
    navigate("/");
  };

  if (loading) {
    return <p className="text-muted-foreground text-sm">Loading...</p>;
  }

  if (!bot || !botId) {
    return <p className="text-muted-foreground text-sm">Bot not found</p>;
  }

  const isRunning = bot.status === "running";

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <Link to="/">
            <Button variant="ghost" size="sm">
              <ArrowLeft className="h-4 w-4" />
              Back
            </Button>
          </Link>
          <h1 className="text-2xl font-bold">{bot.name}</h1>
          <Badge variant={statusBadge[bot.status].variant}>{statusBadge[bot.status].label}</Badge>
        </div>
        <div className="flex items-center gap-2">
          <Link to={`/bots/${botId}/edit`}>
            <Button variant="outline" size="sm">
              <Pencil className="h-4 w-4" />
              Edit
            </Button>
          </Link>
          <Link to={`/logs?botId=${botId}`}>
            <Button variant="outline" size="sm">
              <ScrollText className="h-4 w-4" />
              Logs
            </Button>
          </Link>
          <Button variant="destructive" size="sm" onClick={handleDelete}>
            <Trash2 className="h-4 w-4" />
            Delete
          </Button>
        </div>
      </div>

      <div className="grid gap-4 md:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Bot Info</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="flex items-center gap-2">
              <span className="text-muted-foreground text-sm">Token:</span>
              <span className="font-mono text-sm">{bot.tokenMasked}</span>
            </div>
            <div className="flex items-center gap-2">
              <span className="text-muted-foreground text-sm">Uptime:</span>
              <span className="font-mono text-sm">{formatUptime(bot.uptime)}</span>
            </div>
            <div className="flex items-center gap-2">
              <span className="text-muted-foreground text-sm">Auto-start:</span>
              <span className="text-sm">{bot.isActive ? "Yes" : "No"}</span>
            </div>
            {bot.adminChatIds.length > 0 && (
              <div className="flex items-center gap-2">
                <span className="text-muted-foreground text-sm">Admins:</span>
                <span className="font-mono text-sm">{bot.adminChatIds.join(", ")}</span>
              </div>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">Controls</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="flex flex-wrap gap-2">
              <Button
                size="sm"
                disabled={isRunning || busy}
                onClick={() =>
                  action(() => client.api.bots[":botId"].start.$post({ param: { botId } }))
                }
              >
                <Play className="h-4 w-4" />
                Start
              </Button>
              <Button
                size="sm"
                variant="destructive"
                disabled={!isRunning || busy}
                onClick={() =>
                  action(() => client.api.bots[":botId"].stop.$post({ param: { botId } }))
                }
              >
                <Square className="h-4 w-4" />
                Stop
              </Button>
              <Button
                size="sm"
                variant="outline"
                disabled={!isRunning || busy}
                onClick={() =>
                  action(() => client.api.bots[":botId"].restart.$post({ param: { botId } }))
                }
              >
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
