import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { formatUptime, statusBadge } from "@/lib/bot-utils";
import { client } from "@/lib/client";
import type { BotWithStatus } from "@cos-tool-bot/shared";
import { useInvalidate, useList } from "@refinedev/core";
import { Bot, Play, Plus, Square } from "lucide-react";
import { useState } from "react";
import { useNavigate } from "react-router";

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

  const toggleBot = async (bot: BotWithStatus) => {
    setBusy(bot.id);
    try {
      if (bot.status === "running") {
        await client.api.bots[":botId"].stop.$post({ param: { botId: bot.id } });
      } else {
        await client.api.bots[":botId"].start.$post({ param: { botId: bot.id } });
      }
      invalidate({ resource: "bots", invalidates: ["list"] });
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="space-y-7">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <p className="text-primary mb-1 text-sm font-medium">Workspace</p>
          <h1 className="text-2xl font-semibold tracking-tight sm:text-3xl">Bots</h1>
          <p className="text-muted-foreground mt-1 text-sm">管理、运行并检查你的机器人实例。</p>
        </div>
        <Button size="sm" onClick={() => navigate("/bots/new")}>
          <Plus className="h-4 w-4" />
          Add Bot
        </Button>
      </div>

      {isLoading ? (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3" role="status">
          {[0, 1, 2].map((item) => (
            <div
              key={item}
              className="h-48 animate-pulse rounded-2xl bg-white/70 shadow-[var(--shadow-surface)]"
            />
          ))}
        </div>
      ) : bots.length === 0 ? (
        <Card>
          <CardContent className="flex flex-col items-center gap-3 py-16 text-center">
            <div className="text-primary flex size-12 items-center justify-center rounded-2xl bg-blue-50">
              <Bot className="size-6" />
            </div>
            <div>
              <p className="font-semibold">还没有机器人</p>
              <p className="text-muted-foreground mt-1 text-sm">
                创建第一个机器人，开始配置自动化能力。
              </p>
            </div>
            <Button size="sm" onClick={() => navigate("/bots/new")}>
              <Plus className="h-4 w-4" />
              Add your first bot
            </Button>
          </CardContent>
        </Card>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {bots.map((bot) => (
            <Card
              key={bot.id}
              role="button"
              tabIndex={0}
              className="group focus-visible:ring-ring cursor-pointer transition-[transform,box-shadow] duration-200 ease-out hover:-translate-y-0.5 hover:shadow-[var(--shadow-surface-hover)] focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:outline-none"
              onClick={() => navigate(`/bots/${bot.id}`)}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  navigate(`/bots/${bot.id}`);
                }
              }}
            >
              <CardContent className="space-y-5 p-5 sm:p-6">
                <div className="flex items-start justify-between gap-3">
                  <div className="flex items-center gap-2 truncate">
                    <div className="group-hover:text-primary flex size-9 shrink-0 items-center justify-center rounded-xl bg-slate-100 text-slate-600 transition-[background-color,color] group-hover:bg-blue-50">
                      <Bot className="size-[18px]" />
                    </div>
                    <h3 className="truncate font-semibold">{bot.name}</h3>
                    {bot.platform === "lark-webhook" && (
                      <Badge variant="muted" className="shrink-0 text-[10px]">
                        Lark
                      </Badge>
                    )}
                  </div>
                  <Badge variant={statusBadge[bot.status].variant}>
                    {statusBadge[bot.status].label}
                  </Badge>
                </div>
                <p className="text-muted-foreground truncate rounded-lg bg-slate-50 px-3 py-2 font-mono text-xs">
                  {bot.tokenMasked}
                </p>
                <div className="flex items-center justify-between">
                  <span className="text-muted-foreground text-xs tabular-nums">
                    Uptime: {formatUptime(bot.uptime)}
                  </span>
                  <Button
                    size="sm"
                    variant={bot.status === "running" ? "destructive" : "default"}
                    disabled={busy === bot.id}
                    onClick={(e) => {
                      e.stopPropagation();
                      toggleBot(bot);
                    }}
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
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
