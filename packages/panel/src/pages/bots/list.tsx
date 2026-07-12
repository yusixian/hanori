import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { formatUptime, statusBadge } from "@/lib/bot-utils";
import { client } from "@/lib/client";
import type { BotWithStatus } from "@cos-tool-bot/shared";
import { useInvalidate, useList } from "@refinedev/core";
import { Activity, ArrowUpRight, Bot, KeyRound, Play, Plus, Square } from "lucide-react";
import { useState } from "react";
import { Link, useNavigate } from "react-router";

export function BotListPage() {
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
        alert(`Action failed: ${json.error ?? "unknown error"}`);
        return;
      }
      invalidate({ resource: "bots", invalidates: ["list"] });
    } catch {
      alert("Action failed: network error");
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="space-y-8">
      <div className="flex flex-col gap-6 lg:flex-row lg:items-end lg:justify-between">
        <div className="max-w-2xl">
          <p className="text-primary mb-3 flex items-center gap-2 text-xs font-bold tracking-[0.16em] uppercase">
            <span className="size-1.5 rounded-full bg-blue-500 shadow-[0_0_0_4px_rgb(59_130_246/0.12)]" />
            Workspace / Bots
          </p>
          <h1 className="text-4xl font-semibold tracking-[-0.04em] text-slate-950 sm:text-5xl">
            Bots
          </h1>
          <p className="text-muted-foreground mt-3 max-w-xl text-sm leading-6 sm:text-base">
            管理、运行并检查你的机器人实例。所有状态会自动同步。
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <div className="flex items-center gap-4 rounded-2xl bg-white/70 px-4 py-2.5 shadow-sm ring-1 ring-slate-950/[0.035]">
            <div>
              <p className="text-[10px] font-bold tracking-[0.14em] text-slate-400 uppercase">
                Fleet
              </p>
              <p className="mt-0.5 text-lg font-semibold text-slate-900 tabular-nums">
                {bots.length}
              </p>
            </div>
            <div className="h-8 w-px bg-slate-200" />
            <div>
              <p className="text-[10px] font-bold tracking-[0.14em] text-slate-400 uppercase">
                Running
              </p>
              <p className="mt-0.5 flex items-center gap-1.5 text-lg font-semibold text-emerald-600 tabular-nums">
                <Activity className="size-4" />
                {runningCount}
              </p>
            </div>
          </div>
          <Button onClick={() => navigate("/bots/new")}>
            <Plus className="h-4 w-4" />
            Add Bot
          </Button>
        </div>
      </div>

      {isLoading ? (
        <div
          className="grid gap-5 md:grid-cols-2 xl:grid-cols-3"
          role="status"
          aria-label="Loading bots…"
        >
          {[0, 1, 2].map((item) => (
            <div
              key={item}
              className="h-64 animate-pulse rounded-[24px] bg-white/70 shadow-[var(--shadow-surface)]"
            />
          ))}
        </div>
      ) : bots.length === 0 ? (
        <Card className="overflow-hidden">
          <CardContent className="flex flex-col items-center gap-4 px-6 py-20 text-center sm:py-24">
            <div className="text-primary flex size-16 items-center justify-center rounded-[20px] bg-blue-50 shadow-[inset_0_0_0_1px_rgb(37_99_235/0.08)]">
              <Bot className="size-7" />
            </div>
            <div>
              <p className="text-lg font-semibold text-slate-900">还没有机器人</p>
              <p className="text-muted-foreground mt-2 text-sm">
                创建第一个机器人，开始配置自动化能力。
              </p>
            </div>
            <Button onClick={() => navigate("/bots/new")}>
              <Plus className="h-4 w-4" />
              Add your first bot
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
                Your bots
              </h2>
              <p className="text-muted-foreground mt-1 text-sm">
                选择一个机器人查看详情或管理运行状态。
              </p>
            </div>
            <span className="hidden rounded-full bg-slate-100 px-3 py-1.5 text-xs font-semibold text-slate-500 sm:inline-flex">
              Auto-refresh · 5s
            </span>
          </div>
          <div className="grid gap-5 md:grid-cols-2 xl:grid-cols-3">
            {bots.map((bot) => (
              <Card
                key={bot.id}
                className="group relative overflow-hidden transition-[transform,box-shadow] duration-200 ease-out hover:-translate-y-1 hover:shadow-[var(--shadow-surface-hover)]"
              >
                <div className="absolute inset-x-0 top-0 h-1 bg-gradient-to-r from-blue-500 via-indigo-500 to-violet-500 opacity-80" />
                <Link
                  to={`/bots/${bot.id}`}
                  className="block p-5 outline-none focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:ring-inset sm:p-6"
                >
                  <div className="flex min-h-[76px] items-start justify-between gap-3">
                    <div className="flex min-w-0 items-start gap-3">
                      <div className="flex size-11 shrink-0 items-center justify-center rounded-2xl bg-gradient-to-br from-blue-50 to-indigo-100 text-blue-600 shadow-[inset_0_0_0_1px_rgb(37_99_235/0.08)] transition-[transform,box-shadow] duration-200 group-hover:scale-105 group-hover:shadow-md">
                        <Bot className="size-5" />
                      </div>
                      <div className="min-w-0 pt-0.5">
                        <h3 className="line-clamp-2 text-[17px] leading-6 font-semibold tracking-tight text-slate-900">
                          {bot.name}
                        </h3>
                        {bot.platform === "lark-webhook" && (
                          <Badge variant="muted" className="mt-2 text-[10px]">
                            Lark webhook
                          </Badge>
                        )}
                      </div>
                    </div>
                    <Badge variant={statusBadge[bot.status].variant}>
                      <span
                        className={`mr-1.5 size-1.5 rounded-full ${
                          bot.status === "running"
                            ? "bg-emerald-500"
                            : bot.status === "restarting"
                              ? "bg-amber-500"
                              : "bg-red-500"
                        }`}
                      />
                      {statusBadge[bot.status].label}
                    </Badge>
                  </div>
                  <div className="mt-5 flex items-center gap-2 rounded-xl bg-slate-50 px-3 py-2.5 ring-1 ring-slate-950/[0.025] ring-inset">
                    <KeyRound className="size-3.5 shrink-0 text-slate-400" />
                    <span className="text-muted-foreground min-w-0 truncate font-mono text-xs">
                      {bot.tokenMasked}
                    </span>
                    <ArrowUpRight className="ml-auto size-3.5 shrink-0 text-slate-300 transition-[color,transform] duration-150 group-hover:translate-x-0.5 group-hover:-translate-y-0.5 group-hover:text-blue-500" />
                  </div>
                </Link>
                <div className="flex items-center justify-between gap-3 border-t border-slate-100 bg-slate-50/60 px-5 py-4 sm:px-6">
                  <span className="flex min-w-0 items-center gap-2 text-xs font-medium text-slate-500 tabular-nums">
                    <span
                      className={`size-2 rounded-full ${bot.status === "running" ? "bg-emerald-500" : "bg-slate-300"}`}
                    />
                    <span className="truncate">Uptime · {formatUptime(bot.uptime)}</span>
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
                        Stop
                      </>
                    ) : (
                      <>
                        <Play className="h-3.5 w-3.5" />
                        Start
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
