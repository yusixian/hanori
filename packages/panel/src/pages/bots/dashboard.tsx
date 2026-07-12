import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { formatUptime, statusBadge } from "@/lib/bot-utils";
import { client } from "@/lib/client";
import type { BotWithStatus } from "@cos-tool-bot/shared";
import { useDelete, useInvalidate, useOne } from "@refinedev/core";
import { Play, RefreshCw, Send, Square, Trash2 } from "lucide-react";
import { useState } from "react";
import { useNavigate, useParams } from "react-router";

export function BotDashboardPage() {
  const { botId } = useParams<{ botId: string }>();
  const navigate = useNavigate();
  const [busy, setBusy] = useState(false);
  const invalidate = useInvalidate();

  const { data, isLoading } = useOne<BotWithStatus>({
    resource: "bots",
    id: botId!,
    queryOptions: { enabled: !!botId, refetchInterval: 5000 },
  });

  const { mutateAsync: deleteBot } = useDelete();

  const bot = data?.data;

  const action = async (fn: () => Promise<Response>) => {
    setBusy(true);
    try {
      const res = await fn();
      const json = (await res.json()) as { ok: boolean; error?: string };
      if (!json.ok) {
        alert(`Action failed: ${json.error ?? "unknown error"}`);
        return;
      }
      invalidate({ resource: "bots", invalidates: ["detail", "list"] });
    } catch {
      alert("Action failed: network error");
    } finally {
      setBusy(false);
    }
  };

  const handleDelete = async () => {
    if (!botId || !window.confirm("Are you sure you want to delete this bot?")) return;
    await deleteBot({ resource: "bots", id: botId });
    navigate("/");
  };

  if (isLoading) {
    return <p className="text-muted-foreground text-sm">Loading...</p>;
  }

  if (!bot || !botId) {
    return <p className="text-muted-foreground text-sm">Bot not found</p>;
  }

  const isRunning = bot.status === "running";
  const isLark = bot.platform === "lark-webhook";

  const sendLarkTest = async () => {
    if (!botId) return;
    setBusy(true);
    try {
      const res = await client.api.bots[":botId"].lark.test.$post({
        param: { botId },
        json: { message: "Test message from cos-tool-bot panel" },
      });
      const json = (await res.json()) as { ok: boolean; error?: string };
      if (!json.ok) alert(`Send test failed: ${json.error}`);
    } catch {
      alert("Send test failed: network error");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-7">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <p className="text-primary mb-1 text-sm font-medium">Bot overview</p>
          <div className="flex flex-wrap items-center gap-3">
            <h1 className="text-2xl font-semibold tracking-tight sm:text-3xl">{bot.name}</h1>
            {isLark && <Badge variant="muted">Lark</Badge>}
            <Badge variant={statusBadge[bot.status].variant}>{statusBadge[bot.status].label}</Badge>
          </div>
          <p className="text-muted-foreground mt-1 text-sm">查看运行状态并管理机器人生命周期。</p>
        </div>
      </div>

      <div className="grid gap-4 md:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Bot Info</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="flex items-center justify-between gap-4 border-b pb-3">
              <span className="text-muted-foreground text-sm">Token:</span>
              <span className="font-mono text-sm">{bot.tokenMasked}</span>
            </div>
            <div className="flex items-center justify-between gap-4 border-b pb-3">
              <span className="text-muted-foreground text-sm">Uptime:</span>
              <span className="font-mono text-sm tabular-nums">{formatUptime(bot.uptime)}</span>
            </div>
            <div className="flex items-center justify-between gap-4 border-b pb-3">
              <span className="text-muted-foreground text-sm">Auto-start:</span>
              <span className="text-sm">{bot.isActive ? "Yes" : "No"}</span>
            </div>
            {!isLark && (
              <div className="flex items-center justify-between gap-4 border-b pb-3">
                <span className="text-muted-foreground text-sm">AI Reply:</span>
                <Badge variant={bot.aiEnabled ? "default" : "muted"}>
                  {bot.aiEnabled ? "Enabled" : "Disabled"}
                </Badge>
              </div>
            )}
            {isLark && (
              <div className="flex items-center justify-between gap-4 border-b pb-3">
                <span className="text-muted-foreground text-sm">Platform:</span>
                <span className="text-sm">Lark Webhook</span>
              </div>
            )}
            {bot.adminChatIds.length > 0 && (
              <div className="flex items-center justify-between gap-4">
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
          <CardContent className="space-y-4">
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
              {isLark && (
                <Button
                  size="sm"
                  variant="outline"
                  disabled={!isRunning || busy}
                  onClick={sendLarkTest}
                >
                  <Send className="h-4 w-4" />
                  Send Test
                </Button>
              )}
            </div>
            <div className="border-t pt-4">
              <p className="text-muted-foreground mb-3 text-xs font-medium tracking-wide uppercase">
                Danger zone
              </p>
              <Button variant="destructive" size="sm" onClick={handleDelete}>
                <Trash2 className="h-4 w-4" />
                Delete Bot
              </Button>
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
