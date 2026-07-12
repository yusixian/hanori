import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { getUptimeParts, statusBadgeVariant } from "@/lib/bot-utils";
import { client } from "@/lib/client";
import type { BotWithStatus } from "@cos-tool-bot/shared";
import { useInvalidate, useList } from "@refinedev/core";
import { Activity, ArrowUpRight, Bot, KeyRound, Play, Plus, Square } from "lucide-react";
import { useState } from "react";
import { Link, useNavigate } from "react-router";
import { useTranslation } from "react-i18next";

export function BotListPage() {
  const { t } = useTranslation("bots");
  const navigate = useNavigate();
  const [busy, setBusy] = useState<string | null>(null);
  const invalidate = useInvalidate();

  const { data, isLoading } = useList<BotWithStatus>({
    resource: "bots",
    pagination: { current: 1, pageSize: 100 },
    queryOptions: { refetchInterval: 5000 },
  });

  const bots = data?.data ?? [];
  const runningCount = bots.filter((bot) => bot.status === "running").length;

  const toggleBot = async (bot: BotWithStatus) => {
    setBusy(bot.id);
    try {
      const res =
        bot.status === "running"
          ? await client.api.bots[":botId"].stop.$post({ param: { botId: bot.id } })
          : await client.api.bots[":botId"].start.$post({ param: { botId: bot.id } });
      const json = (await res.json()) as { ok: boolean; error?: string };
      if (!json.ok) {
        alert(t("actions.failed", { error: json.error ?? t("actions.unknownError") }));
        return;
      }
      invalidate({ resource: "bots", invalidates: ["list"] });
    } catch {
      alert(t("actions.networkError"));
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="space-y-8">
      <div className="flex flex-col gap-6 lg:flex-row lg:items-end lg:justify-between">
        <div className="max-w-2xl">
          <h1 className="text-4xl font-semibold tracking-[-0.04em] text-slate-950 sm:text-5xl">
            {t("list.title")}
          </h1>
          <p className="text-muted-foreground mt-3 max-w-xl text-sm leading-6 sm:text-base">
            {t("list.description")}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <div className="flex items-center gap-4 border-r pr-4">
            <div>
              <p className="text-xs text-slate-500">{t("list.botCount")}</p>
              <p className="mt-0.5 text-lg font-semibold text-slate-900 tabular-nums">
                {bots.length}
              </p>
            </div>
            <div className="h-8 w-px bg-slate-200" />
            <div>
              <p className="text-xs text-slate-500">{t("status.running")}</p>
              <p className="mt-0.5 flex items-center gap-1.5 text-lg font-semibold text-emerald-600 tabular-nums">
                <Activity className="size-4" />
                {runningCount}
              </p>
            </div>
          </div>
          <Button onClick={() => navigate("/bots/new")}>
            <Plus className="h-4 w-4" />
            {t("list.addBot")}
          </Button>
        </div>
      </div>

      {isLoading ? (
        <div
          className="grid gap-5 md:grid-cols-2 xl:grid-cols-3"
          role="status"
          aria-label={t("list.loading")}
        >
          {[0, 1, 2].map((item) => (
            <div key={item} className="h-64 animate-pulse rounded-xl border bg-white" />
          ))}
        </div>
      ) : bots.length === 0 ? (
        <Card className="overflow-hidden">
          <CardContent className="flex flex-col items-center gap-4 px-6 py-20 text-center sm:py-24">
            <Bot className="text-primary size-9" />
            <div>
              <p className="text-lg font-semibold text-slate-900">{t("list.emptyTitle")}</p>
              <p className="text-muted-foreground mt-2 text-sm">{t("list.emptyDescription")}</p>
            </div>
            <Button onClick={() => navigate("/bots/new")}>
              <Plus className="h-4 w-4" />
              {t("list.addFirstBot")}
            </Button>
          </CardContent>
        </Card>
      ) : (
        <section aria-labelledby="bot-list-heading">
          <div className="mb-4 flex items-center justify-between gap-4">
            <div>
              <h2
                id="bot-list-heading"
                className="text-lg font-semibold tracking-tight text-slate-900"
              >
                {t("list.yourBots")}
              </h2>
              <p className="text-muted-foreground mt-1 text-sm">{t("list.chooseBot")}</p>
            </div>
            <span className="hidden text-xs text-slate-500 sm:inline-flex">
              {t("list.autoRefresh")}
            </span>
          </div>
          <div className="grid gap-5 md:grid-cols-2 xl:grid-cols-3">
            {bots.map((bot) => (
              <Card
                key={bot.id}
                className="group relative overflow-hidden transition-[border-color,box-shadow] duration-150 hover:border-slate-300 hover:shadow-[var(--shadow-surface-hover)]"
              >
                <Link
                  to={`/bots/${bot.id}`}
                  className="block p-5 outline-none focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:ring-inset sm:p-6"
                >
                  <div className="flex min-h-[76px] items-start justify-between gap-3">
                    <div className="flex min-w-0 items-start gap-3">
                      <div className="flex size-8 shrink-0 items-center justify-center text-slate-500">
                        <Bot className="size-5" />
                      </div>
                      <div className="min-w-0 pt-0.5">
                        <h3 className="line-clamp-2 text-[17px] leading-6 font-semibold tracking-tight text-slate-900 transition-colors duration-200 group-hover:text-blue-700">
                          {bot.name}
                        </h3>
                        {bot.platform === "lark-webhook" && (
                          <Badge variant="muted" className="mt-2 text-[10px]">
                            Lark webhook
                          </Badge>
                        )}
                      </div>
                    </div>
                    <Badge variant={statusBadgeVariant[bot.status]}>
                      <span
                        className={`mr-1.5 size-1.5 rounded-full ${
                          bot.status === "running"
                            ? "bg-emerald-500"
                            : bot.status === "restarting"
                              ? "bg-amber-500"
                              : "bg-red-500"
                        }`}
                      />
                      {t(`status.${bot.status}`)}
                    </Badge>
                  </div>
                  <div className="mt-5 flex items-center gap-2 border-t pt-3">
                    <KeyRound className="size-3.5 shrink-0 text-slate-400" />
                    <span className="text-muted-foreground min-w-0 truncate font-mono text-xs">
                      {bot.tokenMasked}
                    </span>
                    <ArrowUpRight className="ml-auto size-3.5 shrink-0 text-slate-300 transition-colors duration-150 group-hover:text-blue-500" />
                  </div>
                </Link>
                <div className="flex items-center justify-between gap-3 border-t px-5 py-4 sm:px-6">
                  <span className="flex min-w-0 items-center gap-2 text-xs font-medium text-slate-500 tabular-nums">
                    <span
                      className={`size-2 rounded-full ${bot.status === "running" ? "bg-emerald-500" : "bg-slate-300"}`}
                    />
                    <span className="truncate">
                      {t("status.uptimeLabel")} ·{" "}
                      {bot.uptime == null ? "-" : t("status.uptime", getUptimeParts(bot.uptime)!)}
                    </span>
                  </span>
                  <Button
                    size="sm"
                    variant={bot.status === "running" ? "destructive" : "default"}
                    disabled={busy === bot.id}
                    aria-busy={busy === bot.id}
                    onClick={() => toggleBot(bot)}
                  >
                    {bot.status === "running" ? (
                      <>
                        <Square className="h-3.5 w-3.5" />
                        {t("actions.stop")}
                      </>
                    ) : (
                      <>
                        <Play className="h-3.5 w-3.5" />
                        {t("actions.start")}
                      </>
                    )}
                  </Button>
                </div>
              </Card>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}
