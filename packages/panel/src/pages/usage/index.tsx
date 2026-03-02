import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { TokenHeatmap } from "@/components/usage/token-heatmap";
import { Select } from "@/components/ui/select";
import { cn } from "@/lib/utils";
import { formatTokens } from "@/lib/format";
import { client } from "@/lib/client";
import { useCallback, useEffect, useState } from "react";
import {
  AreaChart,
  Area,
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
  ResponsiveContainer,
} from "recharts";

// ── Helpers ──

function daysAgo(days: number): string {
  const d = new Date();
  d.setDate(d.getDate() - days);
  return d.toISOString();
}

type Range = 7 | 30 | 90;

interface Summary {
  totalTokens: number;
  promptTokens: number;
  completionTokens: number;
  requestCount: number;
}

interface TrendPoint {
  date: string;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  requestCount: number;
}

interface ModelStat {
  model: string;
  totalTokens: number;
  promptTokens: number;
  completionTokens: number;
  requestCount: number;
}

interface BotStat {
  botId: string;
  botName: string;
  totalTokens: number;
  promptTokens: number;
  completionTokens: number;
  requestCount: number;
}

interface BotOption {
  id: string;
  name: string;
}

// ── Stat Card ──

function StatCard({ title, value, sub }: { title: string; value: string; sub?: string }) {
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-muted-foreground text-sm font-medium">{title}</CardTitle>
      </CardHeader>
      <CardContent>
        <div className="text-2xl font-bold">{value}</div>
        {sub && <p className="text-muted-foreground text-xs">{sub}</p>}
      </CardContent>
    </Card>
  );
}

// ── Page ──

export function UsagePage() {
  const [range, setRange] = useState<Range>(7);
  const [botId, setBotId] = useState<string>("");
  const [bots, setBots] = useState<BotOption[]>([]);
  const [summary, setSummary] = useState<Summary | null>(null);
  const [trend, setTrend] = useState<TrendPoint[]>([]);
  const [byModel, setByModel] = useState<ModelStat[]>([]);
  const [byBot, setByBot] = useState<BotStat[]>([]);
  const [loading, setLoading] = useState(true);
  const [heatmapData, setHeatmapData] = useState<{ date: string; totalTokens: number }[]>([]);
  const [heatmapLoading, setHeatmapLoading] = useState(true);

  // Load bot list
  useEffect(() => {
    client.api.bots
      .$get({ query: { page: "1", limit: "100" } })
      .then((r) => r.json())
      .then((d) => {
        if (d.ok) {
          setBots(d.data.map((b) => ({ id: b.id, name: b.name })));
        }
      })
      .catch(() => {});
  }, []);

  const fetchData = useCallback(async () => {
    setLoading(true);
    const from = daysAgo(range);
    const params: Record<string, string> = { from };
    if (botId) params.botId = botId;

    try {
      const [summaryRes, trendRes, modelRes, botRes] = await Promise.all([
        client.api.usage.summary.$get({ query: params }),
        client.api.usage.trend.$get({
          query: { ...params, granularity: range <= 7 ? "hour" : "day" },
        }),
        client.api.usage["by-model"].$get({ query: params }),
        client.api.usage["by-bot"].$get({ query: { from } }),
      ]);

      const [summaryData, trendData, modelData, botData] = await Promise.all([
        summaryRes.json(),
        trendRes.json(),
        modelRes.json(),
        botRes.json(),
      ]);

      if (summaryData.ok) setSummary(summaryData.data);
      if (trendData.ok) setTrend(trendData.data);
      if (modelData.ok) setByModel(modelData.data);
      if (botData.ok) setByBot(botData.data);
    } catch {
      // silently fail
    } finally {
      setLoading(false);
    }
  }, [range, botId]);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  // Heatmap: always fetch 365 days, independent of range
  useEffect(() => {
    setHeatmapLoading(true);
    const from = daysAgo(365);
    const params: Record<string, string> = { from, granularity: "day" };
    if (botId) params.botId = botId;
    client.api.usage.trend
      .$get({ query: params })
      .then((r) => r.json())
      .then((d) => {
        if (d.ok) setHeatmapData(d.data);
      })
      .catch(() => {})
      .finally(() => setHeatmapLoading(false));
  }, [botId]);

  const granLabel = range <= 7 ? "hourly" : "daily";

  return (
    <div className="mx-auto max-w-6xl space-y-6">
      {/* Header */}
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <h1 className="text-2xl font-bold">Token Usage</h1>
        <div className="flex items-center gap-2">
          <div className="flex rounded-md border">
            {([7, 30, 90] as Range[]).map((d) => (
              <button
                key={d}
                onClick={() => setRange(d)}
                className={cn(
                  "px-3 py-1.5 text-sm font-medium transition-colors",
                  range === d
                    ? "bg-primary text-primary-foreground"
                    : "text-muted-foreground hover:text-foreground",
                  d === 7 && "rounded-l-md",
                  d === 90 && "rounded-r-md",
                )}
              >
                {d}d
              </button>
            ))}
          </div>
          <Select value={botId} onChange={(e) => setBotId(e.target.value)} className="w-40">
            <option value="">All Bots</option>
            {bots.map((b) => (
              <option key={b.id} value={b.id}>
                {b.name}
              </option>
            ))}
          </Select>
        </div>
      </div>

      {/* Summary Cards */}
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <StatCard title="Total Tokens" value={formatTokens(summary?.totalTokens ?? 0)} />
        <StatCard title="Prompt Tokens" value={formatTokens(summary?.promptTokens ?? 0)} />
        <StatCard title="Completion Tokens" value={formatTokens(summary?.completionTokens ?? 0)} />
        <StatCard title="Requests" value={String(summary?.requestCount ?? 0)} />
      </div>

      {/* Daily Activity Heatmap */}
      <Card>
        <CardHeader>
          <CardTitle>Daily Activity</CardTitle>
        </CardHeader>
        <CardContent>
          <TokenHeatmap data={heatmapData} loading={heatmapLoading} />
        </CardContent>
      </Card>

      {/* Trend Chart */}
      <Card>
        <CardHeader>
          <CardTitle>Usage Trend ({granLabel})</CardTitle>
        </CardHeader>
        <CardContent>
          {loading && trend.length === 0 ? (
            <div className="text-muted-foreground flex h-64 items-center justify-center text-sm">
              Loading...
            </div>
          ) : trend.length === 0 ? (
            <div className="text-muted-foreground flex h-64 items-center justify-center text-sm">
              No data
            </div>
          ) : (
            <ResponsiveContainer width="100%" height={300}>
              <AreaChart data={trend}>
                <CartesianGrid strokeDasharray="3 3" className="stroke-border" />
                <XAxis
                  dataKey="date"
                  tickFormatter={(v: string) => {
                    const d = new Date(v);
                    return range <= 7
                      ? `${d.getMonth() + 1}/${d.getDate()} ${d.getHours()}:00`
                      : `${d.getMonth() + 1}/${d.getDate()}`;
                  }}
                  className="text-xs"
                />
                <YAxis tickFormatter={formatTokens} className="text-xs" />
                <Tooltip
                  formatter={(value) => formatTokens(Number(value))}
                  labelFormatter={(label) => new Date(String(label)).toLocaleString()}
                />
                <Legend />
                <Area
                  type="monotone"
                  dataKey="promptTokens"
                  stackId="1"
                  name="Prompt"
                  stroke="#3b82f6"
                  fill="#3b82f6"
                  fillOpacity={0.6}
                />
                <Area
                  type="monotone"
                  dataKey="completionTokens"
                  stackId="1"
                  name="Completion"
                  stroke="#f97316"
                  fill="#f97316"
                  fillOpacity={0.6}
                />
              </AreaChart>
            </ResponsiveContainer>
          )}
        </CardContent>
      </Card>

      {/* Bottom Charts */}
      <div className="grid gap-6 lg:grid-cols-2">
        {/* By Model */}
        <Card>
          <CardHeader>
            <CardTitle>By Model</CardTitle>
          </CardHeader>
          <CardContent>
            {byModel.length === 0 ? (
              <div className="text-muted-foreground flex h-48 items-center justify-center text-sm">
                No data
              </div>
            ) : (
              <ResponsiveContainer width="100%" height={Math.max(byModel.length * 40, 120)}>
                <BarChart data={byModel} layout="vertical">
                  <CartesianGrid strokeDasharray="3 3" className="stroke-border" />
                  <XAxis type="number" tickFormatter={formatTokens} className="text-xs" />
                  <YAxis
                    type="category"
                    dataKey="model"
                    width={140}
                    className="text-xs"
                    tick={{ fontSize: 11 }}
                  />
                  <Tooltip formatter={(value) => formatTokens(Number(value))} />
                  <Legend />
                  <Bar dataKey="promptTokens" name="Prompt" fill="#3b82f6" stackId="a" />
                  <Bar dataKey="completionTokens" name="Completion" fill="#f97316" stackId="a" />
                </BarChart>
              </ResponsiveContainer>
            )}
          </CardContent>
        </Card>

        {/* By Bot */}
        <Card>
          <CardHeader>
            <CardTitle>By Bot</CardTitle>
          </CardHeader>
          <CardContent>
            {byBot.length === 0 ? (
              <div className="text-muted-foreground flex h-48 items-center justify-center text-sm">
                No data
              </div>
            ) : (
              <ResponsiveContainer width="100%" height={Math.max(byBot.length * 40, 120)}>
                <BarChart data={byBot} layout="vertical">
                  <CartesianGrid strokeDasharray="3 3" className="stroke-border" />
                  <XAxis type="number" tickFormatter={formatTokens} className="text-xs" />
                  <YAxis
                    type="category"
                    dataKey="botName"
                    width={120}
                    className="text-xs"
                    tick={{ fontSize: 11 }}
                  />
                  <Tooltip formatter={(value) => formatTokens(Number(value))} />
                  <Legend />
                  <Bar dataKey="promptTokens" name="Prompt" fill="#3b82f6" stackId="a" />
                  <Bar dataKey="completionTokens" name="Completion" fill="#f97316" stackId="a" />
                </BarChart>
              </ResponsiveContainer>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
