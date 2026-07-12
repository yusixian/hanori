import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { getUptimeParts, statusBadgeVariant } from "@/lib/bot-utils";
import { client } from "@/lib/client";
import type { BotWithStatus } from "@cos-tool-bot/shared";
import { useDelete, useInvalidate, useOne } from "@refinedev/core";
import { Play, RefreshCw, Send, Square, Trash2 } from "lucide-react";
import { useState } from "react";
import { useNavigate, useParams } from "react-router";
import { useTranslation } from "react-i18next";

export function BotDashboardPage() {
  const { t } = useTranslation("bots");
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
        alert(t("actions.failed", { error: json.error ?? t("actions.unknownError") }));
        return;
      }
      invalidate({ resource: "bots", invalidates: ["detail", "list"] });
    } catch {
      alert(t("actions.networkError"));
    } finally {
      setBusy(false);
    }
  };

  const handleDelete = async () => {
    if (!botId || !window.confirm(t("dashboard.confirmDelete"))) return;
    await deleteBot({ resource: "bots", id: botId });
    navigate("/");
  };

  if (isLoading) {
    return <p className="text-muted-foreground text-sm">{t("common:common.loading")}</p>;
  }

  if (!bot || !botId) {
    return <p className="text-muted-foreground text-sm">{t("dashboard.notFound")}</p>;
  }

  const isRunning = bot.status === "running";
  const isLark = bot.platform === "lark-webhook";

  const sendLarkTest = async () => {
    if (!botId) return;
    setBusy(true);
    try {
      const res = await client.api.bots[":botId"].lark.test.$post({
        param: { botId },
        json: { message: t("dashboard.larkTestMessage") },
      });
      const json = (await res.json()) as { ok: boolean; error?: string };
      if (!json.ok) {
        alert(
          t("dashboard.sendTestFailed", {
            error: json.error ?? t("actions.unknownError"),
          }),
        );
      }
    } catch {
      alert(t("dashboard.sendTestNetworkError"));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-7">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <p className="text-primary mb-1 text-sm font-medium">{t("dashboard.eyebrow")}</p>
          <div className="flex flex-wrap items-center gap-3">
            <h1 className="text-2xl font-semibold tracking-tight sm:text-3xl">{bot.name}</h1>
            {isLark && <Badge variant="muted">Lark</Badge>}
            <Badge variant={statusBadgeVariant[bot.status]}>{t(`status.${bot.status}`)}</Badge>
          </div>
          <p className="text-muted-foreground mt-1 text-sm">{t("dashboard.description")}</p>
        </div>
      </div>

      <div className="grid gap-4 md:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle className="text-base">{t("dashboard.botInfo")}</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="flex items-center justify-between gap-4 border-b pb-3">
              <span className="text-muted-foreground text-sm">{t("dashboard.token")}</span>
              <span className="font-mono text-sm">{bot.tokenMasked}</span>
            </div>
            <div className="flex items-center justify-between gap-4 border-b pb-3">
              <span className="text-muted-foreground text-sm">{t("status.uptimeLabel")}</span>
              <span className="font-mono text-sm tabular-nums">
                {bot.uptime == null ? "-" : t("status.uptime", getUptimeParts(bot.uptime)!)}
              </span>
            </div>
            <div className="flex items-center justify-between gap-4 border-b pb-3">
              <span className="text-muted-foreground text-sm">{t("dashboard.autoStart")}</span>
              <span className="text-sm">
                {bot.isActive ? t("dashboard.yes") : t("dashboard.no")}
              </span>
            </div>
            {!isLark && (
              <div className="flex items-center justify-between gap-4 border-b pb-3">
                <span className="text-muted-foreground text-sm">{t("dashboard.aiReply")}</span>
                <Badge variant={bot.aiEnabled ? "default" : "muted"}>
                  {bot.aiEnabled ? t("common:common.enabled") : t("common:common.disabled")}
                </Badge>
              </div>
            )}
            {isLark && (
              <div className="flex items-center justify-between gap-4 border-b pb-3">
                <span className="text-muted-foreground text-sm">{t("dashboard.platform")}</span>
                <span className="text-sm">Lark Webhook</span>
              </div>
            )}
            {bot.adminChatIds.length > 0 && (
              <div className="flex items-center justify-between gap-4">
                <span className="text-muted-foreground text-sm">{t("dashboard.admins")}</span>
                <span className="font-mono text-sm">{bot.adminChatIds.join(", ")}</span>
              </div>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">{t("dashboard.controls")}</CardTitle>
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
                {t("actions.start")}
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
                {t("actions.stop")}
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
                {t("actions.restart")}
              </Button>
              {isLark && (
                <Button
                  size="sm"
                  variant="outline"
                  disabled={!isRunning || busy}
                  onClick={sendLarkTest}
                >
                  <Send className="h-4 w-4" />
                  {t("dashboard.sendTest")}
                </Button>
              )}
            </div>
            <div className="border-t pt-4">
              <p className="text-muted-foreground mb-3 text-xs font-medium tracking-wide uppercase">
                {t("dashboard.dangerZone")}
              </p>
              <Button variant="destructive" size="sm" onClick={handleDelete}>
                <Trash2 className="h-4 w-4" />
                {t("dashboard.deleteBot")}
              </Button>
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
