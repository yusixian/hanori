import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { TokenHeatmap } from "@/components/usage/token-heatmap";
import { Select } from "@/components/ui/select";
import { cn } from "@/lib/utils";
import { formatTokens } from "@/lib/format";
import { client } from "@/lib/client";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
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
  const { t, i18n } = useTranslation("admin");
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

  const locale = i18n.resolvedLanguage;
  const shortDateFormatter = useMemo(
    () => new Intl.DateTimeFormat(locale, { month: "numeric", day: "numeric" }),
    [locale],
  );
  const shortDateTimeFormatter = useMemo(
    () =>
      new Intl.DateTimeFormat(locale, {
        month: "numeric",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
      }),
    [locale],
  );
  const dateTimeFormatter = useMemo(
    () =>
      new Intl.DateTimeFormat(locale, {
        dateStyle: "medium",
        timeStyle: "medium",
      }),
    [locale],
  );
  const numberFormatter = useMemo(() => new Intl.NumberFormat(locale), [locale]);
  const granLabel = range <= 7 ? t("usage.hourly") : t("usage.daily");

  return (
    <div className="mx-auto max-w-6xl space-y-6">
      {/* Header */}
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <h1 className="text-2xl font-bold">{t("usage.title")}</h1>
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
                {t("usage.days", { count: d })}
              </button>
            ))}
          </div>
          <Select value={botId} onChange={(e) => setBotId(e.target.value)} className="w-40">
            <option value="">{t("usage.allBots")}</option>
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
        <StatCard title={t("usage.totalTokens")} value={formatTokens(summary?.totalTokens ?? 0)} />
        <StatCard
          title={t("usage.promptTokens")}
          value={formatTokens(summary?.promptTokens ?? 0)}
        />
        <StatCard
          title={t("usage.completionTokens")}
          value={formatTokens(summary?.completionTokens ?? 0)}
        />
        <StatCard
          title={t("usage.requests")}
          value={numberFormatter.format(summary?.requestCount ?? 0)}
        />
      </div>

      {/* Daily Activity Heatmap */}
      <Card>
        <CardHeader>
          <CardTitle>{t("usage.dailyActivity")}</CardTitle>
        </CardHeader>
        <CardContent>
          <TokenHeatmap data={heatmapData} loading={heatmapLoading} />
        </CardContent>
      </Card>

      {/* Trend Chart */}
      <Card>
        <CardHeader>
          <CardTitle>{t("usage.trend", { granularity: granLabel })}</CardTitle>
        </CardHeader>
        <CardContent>
          {loading && trend.length === 0 ? (
            <div className="text-muted-foreground flex h-64 items-center justify-center text-sm">
              {t("usage.loading")}
            </div>
          ) : trend.length === 0 ? (
            <div className="text-muted-foreground flex h-64 items-center justify-center text-sm">
              {t("usage.noData")}
            </div>
          ) : (
            <ResponsiveContainer width="100%" height={300}>
              <AreaChart data={trend}>
                <CartesianGrid strokeDasharray="3 3" className="stroke-border" />
                <XAxis
                  dataKey="date"
                  tickFormatter={(v: string) => {
                    const date = new Date(v);
                    return range <= 7
                      ? shortDateTimeFormatter.format(date)
                      : shortDateFormatter.format(date);
                  }}
                  className="text-xs"
                />
                <YAxis tickFormatter={formatTokens} className="text-xs" />
                <Tooltip
                  formatter={(value) => formatTokens(Number(value))}
                  labelFormatter={(label) => dateTimeFormatter.format(new Date(String(label)))}
                />
                <Legend />
                <Area
                  type="monotone"
                  dataKey="promptTokens"
                  stackId="1"
                  name={t("usage.prompt")}
                  stroke="#3b82f6"
                  fill="#3b82f6"
                  fillOpacity={0.6}
                />
                <Area
                  type="monotone"
                  dataKey="completionTokens"
                  stackId="1"
                  name={t("usage.completion")}
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
            <CardTitle>{t("usage.byModel")}</CardTitle>
          </CardHeader>
          <CardContent>
            {byModel.length === 0 ? (
              <div className="text-muted-foreground flex h-48 items-center justify-center text-sm">
                {t("usage.noData")}
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
                  <Bar dataKey="promptTokens" name={t("usage.prompt")} fill="#3b82f6" stackId="a" />
                  <Bar
                    dataKey="completionTokens"
                    name={t("usage.completion")}
                    fill="#f97316"
                    stackId="a"
                  />
                </BarChart>
              </ResponsiveContainer>
            )}
          </CardContent>
        </Card>

        {/* By Bot */}
        <Card>
          <CardHeader>
            <CardTitle>{t("usage.byBot")}</CardTitle>
          </CardHeader>
          <CardContent>
            {byBot.length === 0 ? (
              <div className="text-muted-foreground flex h-48 items-center justify-center text-sm">
                {t("usage.noData")}
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
                  <Bar dataKey="promptTokens" name={t("usage.prompt")} fill="#3b82f6" stackId="a" />
                  <Bar
                    dataKey="completionTokens"
                    name={t("usage.completion")}
                    fill="#f97316"
                    stackId="a"
                  />
                </BarChart>
              </ResponsiveContainer>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
