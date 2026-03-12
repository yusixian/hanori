import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { formatUptime, statusBadge } from "@/lib/bot-utils";
import { client } from "@/lib/client";
import type { BotWithStatus } from "@cos-tool-bot/shared";
import { useInvalidate, useList } from "@refinedev/core";
import { Play, Plus, Square } from "lucide-react";
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
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold">Bots</h1>
        <Link to="/bots/new">
          <Button size="sm">
            <Plus className="h-4 w-4" />
            Add Bot
          </Button>
        </Link>
      </div>

      {isLoading ? (
        <p className="text-muted-foreground text-sm">Loading...</p>
      ) : bots.length === 0 ? (
        <Card>
          <CardContent className="flex flex-col items-center gap-3 py-12">
            <p className="text-muted-foreground text-sm">No bots configured</p>
            <Link to="/bots/new">
              <Button size="sm">
                <Plus className="h-4 w-4" />
                Add your first bot
              </Button>
            </Link>
          </CardContent>
        </Card>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {bots.map((bot) => (
            <Card
              key={bot.id}
              role="button"
              tabIndex={0}
              className="hover:border-primary/50 focus-visible:ring-ring cursor-pointer transition-colors focus-visible:ring-2 focus-visible:outline-none"
              onClick={() => navigate(`/bots/${bot.id}`)}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  navigate(`/bots/${bot.id}`);
                }
              }}
            >
              <CardContent className="space-y-3 p-4 sm:p-6">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2 truncate">
                    <h3 className="truncate font-medium">{bot.name}</h3>
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
                <p className="text-muted-foreground truncate font-mono text-xs">
                  {bot.tokenMasked}
                </p>
                <div className="flex items-center justify-between">
                  <span className="text-muted-foreground text-xs">
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
