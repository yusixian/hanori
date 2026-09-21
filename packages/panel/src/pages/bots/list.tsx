import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Pagination } from "@/components/ui/pagination";
import { getUptimeParts, statusBadgeVariant } from "@/lib/bot-utils";
import { client } from "@/lib/client";
import type { BotWithStatus } from "@cos-tool-bot/shared";
import { useInvalidate, useList } from "@refinedev/core";
import { AlertTriangle, Bot, Play, Plus, RefreshCw, Square } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Link, useNavigate } from "react-router";
import { useTranslation } from "react-i18next";

const PAGE_SIZE = 12;

export function BotListPage() {
  const { t } = useTranslation("bots");
  const navigate = useNavigate();
  const [busy, setBusy] = useState<string | null>(null);
  const [page, setPage] = useState(1);
  const pendingPageFocusRef = useRef(false);
  const invalidate = useInvalidate();

  const { data, isLoading, isFetching, isError, refetch } = useList<BotWithStatus>({
    resource: "bots",
    pagination: { current: page, pageSize: PAGE_SIZE },
    queryOptions: { refetchInterval: 5000 },
  });

  const bots = data?.data ?? [];
  const total = data?.total ?? 0;
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const pageOutOfRange = data !== undefined && page > totalPages;

  useEffect(() => {
    if (!pageOutOfRange) return;
    pendingPageFocusRef.current = true;
    setPage(totalPages);
  }, [pageOutOfRange, totalPages]);

  useEffect(() => {
    if (!pendingPageFocusRef.current || isLoading || isFetching || pageOutOfRange || !data) return;

    const frame = requestAnimationFrame(() => {
      const heading = document.getElementById("bot-list-heading");
      if (!heading) return;
      heading.scrollIntoView({ block: "start" });
      heading.focus({ preventScroll: true });
      pendingPageFocusRef.current = false;
    });
    return () => cancelAnimationFrame(frame);
  }, [data, isFetching, isLoading, page, pageOutOfRange]);

  const handlePageChange = (nextPage: number) => {
    if (nextPage === page) return;
    pendingPageFocusRef.current = true;
    setPage(nextPage);
  };

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
    <div className="space-y-6">
      <div className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
        <div className="max-w-2xl">
          <h1 className="text-3xl font-semibold tracking-[-0.035em] text-slate-950 sm:text-4xl">
            {t("list.title")}
          </h1>
          <p className="text-muted-foreground mt-3 max-w-xl text-sm leading-6 sm:text-base">
            {t("list.description")}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          {data && (
            <div>
              <p className="text-xs text-slate-500">{t("list.botCount")}</p>
              <p
                className="mt-0.5 text-lg font-semibold text-slate-900 tabular-nums"
                data-testid="bot-total"
              >
                {total}
              </p>
            </div>
          )}
          <Button onClick={() => navigate("/bots/new")}>
            <Plus className="h-4 w-4" />
            {t("list.addBot")}
          </Button>
        </div>
      </div>

      {isError && data && (
        <div
          className="flex flex-col gap-3 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-950 sm:flex-row sm:items-center sm:justify-between"
          role="alert"
        >
          <span className="flex items-start gap-2">
            <AlertTriangle aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
            {t("list.staleData")}
          </span>
          <Button size="sm" variant="outline" disabled={isFetching} onClick={() => void refetch()}>
            <RefreshCw className={`size-3.5 ${isFetching ? "animate-spin" : ""}`} />
            {t("list.retry")}
          </Button>
        </div>
      )}

      {isLoading || pageOutOfRange ? (
        <div
          className="grid gap-3 md:grid-cols-2 xl:grid-cols-3"
          role="status"
          aria-label={t("list.loading")}
        >
          {[0, 1, 2].map((item) => (
            <div key={item} className="h-40 animate-pulse rounded-xl border bg-white" />
          ))}
        </div>
      ) : isError && !data ? (
        <Card role="alert">
          <CardContent className="flex flex-col items-start gap-4 px-5 py-8 sm:px-6 sm:py-8">
            <div>
              <p className="font-semibold text-slate-900">{t("list.loadErrorTitle")}</p>
              <p className="text-muted-foreground mt-1 text-sm">{t("list.loadErrorDescription")}</p>
            </div>
            <Button disabled={isFetching} onClick={() => void refetch()}>
              <RefreshCw className={`size-4 ${isFetching ? "animate-spin" : ""}`} />
              {t("list.retry")}
            </Button>
          </CardContent>
        </Card>
      ) : bots.length === 0 ? (
        <Card className="overflow-hidden">
          <CardContent className="flex flex-col items-center gap-4 px-6 py-20 text-center sm:py-24">
            <Bot className="text-primary size-9" />
            <div>
              <p
                id="bot-list-heading"
                tabIndex={-1}
                className="text-lg font-semibold text-slate-900"
              >
                {t("list.emptyTitle")}
              </p>
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
                tabIndex={-1}
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
          <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
            {bots.map((bot) => (
              <Card
                key={bot.id}
                data-testid="bot-card"
                className="group relative overflow-hidden transition-[border-color,box-shadow] duration-150 hover:border-slate-300 hover:shadow-[var(--shadow-surface-hover)]"
              >
                <Link
                  to={`/bots/${bot.id}`}
                  className="block p-4 outline-none focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:ring-inset"
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="flex min-w-0 items-start gap-3">
                      <div className="flex size-7 shrink-0 items-center justify-center text-slate-500">
                        <Bot className="size-4.5" />
                      </div>
                      <div className="min-w-0">
                        <h3 className="line-clamp-2 text-base leading-6 font-semibold tracking-tight text-slate-900 transition-colors duration-150 group-hover:text-blue-700">
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
                </Link>
                <div className="flex items-center justify-between gap-3 border-t px-4 py-3">
                  <span className="min-w-0 text-xs font-medium text-slate-500 tabular-nums">
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
          <div className="mt-5 flex flex-col items-center justify-between gap-3 text-sm text-slate-500 sm:flex-row">
            <span>
              {t("list.pageSummary", {
                from: (page - 1) * PAGE_SIZE + 1,
                to: Math.min(page * PAGE_SIZE, total),
                total,
              })}
            </span>
            <Pagination page={page} totalPages={totalPages} onPageChange={handlePageChange} />
          </div>
        </section>
      )}
    </div>
  );
}
