import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { TokenHeatmap } from "@/components/usage/token-heatmap";
import { Select } from "@/components/ui/select";
import { cn } from "@/lib/utils";
import { formatTokens } from "@/lib/format";
import { client } from "@/lib/client";
import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  AreaChart,
  Area,
  BarChart,
  Bar,
  LineChart,
  Line,
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
  cacheReadTokens: number;
  cacheWriteTokens: number;
  cacheObservedRequestCount: number;
  cacheWriteObservedRequestCount: number;
  cacheHitRequestCount: number;
  cacheObservationRate: number | null;
  cacheTokenHitRate: number | null;
  cacheRequestHitRate: number | null;
}

interface TrendPoint {
  date: string;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  requestCount: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  cacheObservedRequestCount: number;
  cacheWriteObservedRequestCount: number;
  cacheHitRequestCount: number;
  cacheObservationRate: number | null;
  cacheTokenHitRate: number | null;
  cacheRequestHitRate: number | null;
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

const BOT_OPTIONS_PAGE_SIZE = 100;

async function loadAllBotOptions(signal: AbortSignal): Promise<BotOption[]> {
  const options = new Map<string, BotOption>();
  let page = 1;
  let expectedTotal: number | undefined;

  while (true) {
    const response = await client.api.bots.$get(
      { query: { page: String(page), limit: String(BOT_OPTIONS_PAGE_SIZE) } },
      { init: { signal } },
    );
    if (!response.ok) throw new Error("Bot list request failed");
    const result = await response.json();
    if (!result.ok) throw new Error("Bot list request failed");
    expectedTotal ??= result.total;
    if (result.total !== expectedTotal) throw new Error("Bot list changed during pagination");
    for (const bot of result.data) options.set(bot.id, { id: bot.id, name: bot.name });

    const totalPages = Math.max(1, Math.ceil(expectedTotal / BOT_OPTIONS_PAGE_SIZE));
    if (page >= totalPages) {
      if (options.size !== expectedTotal) throw new Error("Bot list pagination was incomplete");
      return [...options.values()];
    }
    if (result.data.length === 0) throw new Error("Bot list pagination was incomplete");
    page += 1;
  }
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

function LoadError({ message, onRetry }: { message: string; onRetry: () => void }) {
  const { t } = useTranslation("admin");
  return (
    <div role="alert" className="flex flex-wrap items-center gap-3 rounded-md border p-4 text-sm">
      <span className="text-destructive flex-1">{message}</span>
      <Button variant="outline" size="sm" onClick={onRetry}>
        {t("common:common.retry")}
      </Button>
    </div>
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
  const [byBotLoading, setByBotLoading] = useState(true);
  const [heatmapData, setHeatmapData] = useState<{ date: string; totalTokens: number }[]>([]);
  const [heatmapLoading, setHeatmapLoading] = useState(true);

  const [error, setError] = useState(false);
  const [byBotError, setByBotError] = useState(false);
  const [heatmapError, setHeatmapError] = useState(false);
  const [botsError, setBotsError] = useState(false);
  const [retry, setRetry] = useState(0);
  const [byBotRetry, setByBotRetry] = useState(0);
  const [heatmapRetry, setHeatmapRetry] = useState(0);
  const [botsRetry, setBotsRetry] = useState(0);

  useEffect(() => {
    let active = true;
    const controller = new AbortController();
    setBotsError(false);
    void (async () => {
      try {
        const options = await loadAllBotOptions(controller.signal);
        if (active) setBots(options);
      } catch {
        if (active && !controller.signal.aborted) setBotsError(true);
      }
    })();
    return () => {
      active = false;
      controller.abort();
    };
  }, [botsRetry]);

  useEffect(() => {
    let active = true;
    setLoading(true);
    setError(false);
    const from = daysAgo(range);
    const params: Record<string, string> = { from };
    if (botId) params.botId = botId;

    void (async () => {
      try {
        const responses = await Promise.all([
          client.api.usage.summary.$get({ query: params }),
          client.api.usage.trend.$get({
            query: { ...params, granularity: range <= 7 ? "hour" : "day" },
          }),
          client.api.usage["by-model"].$get({ query: params }),
        ]);
        if (responses.some((response) => !response.ok)) throw new Error("Usage request failed");
        const [summaryData, trendData, modelData] = await Promise.all([
          responses[0].json(),
          responses[1].json(),
          responses[2].json(),
        ]);
        if (!summaryData.ok || !trendData.ok || !modelData.ok) {
          throw new Error("Usage request failed");
        }
        if (!active) return;
        setSummary(summaryData.data);
        setTrend(trendData.data);
        setByModel(modelData.data);
      } catch {
        if (active) setError(true);
      } finally {
        if (active) setLoading(false);
      }
    })();
    return () => {
      active = false;
    };
  }, [range, botId, retry]);

  // This comparison is intentionally global and only follows the selected time range.
  useEffect(() => {
    let active = true;
    setByBotLoading(true);
    setByBotError(false);
    const from = daysAgo(range);
    void (async () => {
      try {
        const response = await client.api.usage["by-bot"].$get({ query: { from } });
        if (!response.ok) throw new Error("Bot comparison request failed");
        const result = await response.json();
        if (!result.ok) throw new Error("Bot comparison request failed");
        if (active) setByBot(result.data);
      } catch {
        if (active) setByBotError(true);
      } finally {
        if (active) setByBotLoading(false);
      }
    })();
    return () => {
      active = false;
    };
  }, [range, byBotRetry]);

  // Heatmap: always fetch 365 days, independent of range.
  useEffect(() => {
    let active = true;
    setHeatmapLoading(true);
    setHeatmapError(false);
    const params: Record<string, string> = { from: daysAgo(365), granularity: "day" };
    if (botId) params.botId = botId;
    void (async () => {
      try {
        const response = await client.api.usage.trend.$get({ query: params });
        if (!response.ok) throw new Error("Heatmap request failed");
        const result = await response.json();
        if (!result.ok) throw new Error("Heatmap request failed");
        if (active) setHeatmapData(result.data);
      } catch {
        if (active) setHeatmapError(true);
      } finally {
        if (active) setHeatmapLoading(false);
      }
    })();
    return () => {
      active = false;
    };
  }, [botId, heatmapRetry]);

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
  const percentFormatter = useMemo(
    () => new Intl.NumberFormat(locale, { style: "percent", maximumFractionDigits: 1 }),
    [locale],
  );
  const formatRate = (value: number | null | undefined) =>
    value == null ? "—" : percentFormatter.format(value);
  const granLabel = range <= 7 ? t("usage.hourly") : t("usage.daily");
  const selectedBotName = botId
    ? (bots.find((bot) => bot.id === botId)?.name ?? t("usage.selectedBot"))
    : t("usage.allBots");
  const maxModelTokens = byModel.reduce(
    (max, model) => Math.max(max, model.promptTokens + model.completionTokens),
    0,
  );

  return (
    <div className="mx-auto max-w-6xl min-w-0 space-y-6">
      {/* Header */}
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div className="min-w-0">
          <h1 className="text-2xl font-bold">{t("usage.title")}</h1>
          <p className="text-muted-foreground mt-1 text-sm [overflow-wrap:anywhere] break-words">
            {t("usage.rangeSummary", { bot: selectedBotName, count: range })}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <div className="flex rounded-md border">
            {([7, 30, 90] as Range[]).map((d) => (
              <button
                key={d}
                onClick={() => setRange(d)}
                aria-pressed={range === d}
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
          <Select
            aria-label={t("usage.botFilter")}
            value={botId}
            onChange={(e) => setBotId(e.target.value)}
            className="w-40 [&>span:first-child]:min-w-0 [&>span:first-child]:truncate [&>span:last-child]:shrink-0"
          >
            <option value="">{t("usage.allBots")}</option>
            {bots.map((b) => (
              <option key={b.id} value={b.id}>
                {b.name}
              </option>
            ))}
          </Select>
        </div>
      </div>

      {botsError && (
        <LoadError message={t("usage.botsLoadError")} onRetry={() => setBotsRetry((n) => n + 1)} />
      )}

      {loading ? (
        <div role="status" className="text-muted-foreground py-8 text-center text-sm">
          {t("usage.loading")}
        </div>
      ) : error ? (
        <LoadError message={t("usage.loadError")} onRetry={() => setRetry((n) => n + 1)} />
      ) : (
        <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
          <StatCard
            title={t("usage.totalTokens")}
            value={formatTokens(summary?.totalTokens ?? 0)}
          />
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
      )}

      {!loading && !error && (
        <Card>
          <CardHeader>
            <CardTitle>{t("usage.trend", { granularity: granLabel })}</CardTitle>
          </CardHeader>
          <CardContent>
            {trend.length === 0 ? (
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
      )}

      <div className="grid gap-6 lg:grid-cols-2">
        {!loading && !error && (
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
                <ul className="space-y-4">
                  {byModel.map((model) => (
                    <li key={model.model} className="min-w-0 space-y-2">
                      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 text-sm">
                        <span className="min-w-0 font-medium break-all">{model.model}</span>
                        <span className="text-muted-foreground shrink-0 tabular-nums">
                          <span className="sr-only">{t("usage.totalTokens")}: </span>
                          {formatTokens(model.totalTokens)}
                        </span>
                      </div>
                      <div
                        className="bg-muted flex h-3 overflow-hidden rounded-full"
                        aria-hidden="true"
                      >
                        <div
                          className="bg-blue-500"
                          style={{
                            width: `${(model.promptTokens / maxModelTokens) * 100 || 0}%`,
                          }}
                        />
                        <div
                          className="bg-orange-500"
                          style={{
                            width: `${(model.completionTokens / maxModelTokens) * 100 || 0}%`,
                          }}
                        />
                      </div>
                      <div className="text-muted-foreground flex flex-wrap gap-x-4 gap-y-1 text-xs tabular-nums">
                        <span className="flex items-center gap-1.5">
                          <span className="size-2.5 rounded-sm bg-blue-500" aria-hidden="true" />
                          {t("usage.prompt")}: {formatTokens(model.promptTokens)}
                        </span>
                        <span className="flex items-center gap-1.5">
                          <span className="size-2.5 rounded-sm bg-orange-500" aria-hidden="true" />
                          {t("usage.completion")}: {formatTokens(model.completionTokens)}
                        </span>
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </CardContent>
          </Card>
        )}

        <Card>
          <CardHeader>
            <CardTitle>{t("usage.byBot")}</CardTitle>
            <p className="text-muted-foreground text-sm">{t("usage.byBotScope")}</p>
          </CardHeader>
          <CardContent>
            {byBotLoading ? (
              <div role="status" className="text-muted-foreground py-8 text-center text-sm">
                {t("usage.loading")}
              </div>
            ) : byBotError ? (
              <LoadError
                message={t("usage.byBotLoadError")}
                onRetry={() => setByBotRetry((n) => n + 1)}
              />
            ) : byBot.length === 0 ? (
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

      {!loading && !error && (
        <section aria-labelledby="usage-cache-heading" className="space-y-4">
          <div>
            <h2 id="usage-cache-heading" className="text-xl font-semibold">
              {t("usage.cacheDiagnostics")}
            </h2>
            <p className="text-muted-foreground mt-1 text-sm">
              {t("usage.cacheDiagnosticsDescription")}
            </p>
          </div>

          <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
            <StatCard
              title={t("usage.cacheReadTokens")}
              value={
                summary && summary.cacheObservedRequestCount > 0
                  ? formatTokens(summary.cacheReadTokens)
                  : "—"
              }
            />
            <StatCard
              title={t("usage.cacheTokenHitRate")}
              value={formatRate(summary?.cacheTokenHitRate)}
              sub={
                summary
                  ? t("usage.cacheHitRequests", {
                      hit: numberFormatter.format(summary.cacheHitRequestCount),
                      observed: numberFormatter.format(summary.cacheObservedRequestCount),
                    })
                  : undefined
              }
            />
            <StatCard
              title={t("usage.cacheObservationRate")}
              value={formatRate(summary?.cacheObservationRate)}
              sub={
                summary
                  ? t("usage.cacheObservedRequests", {
                      observed: numberFormatter.format(summary.cacheObservedRequestCount),
                      total: numberFormatter.format(summary.requestCount),
                    })
                  : undefined
              }
            />
            <StatCard
              title={t("usage.cacheWriteTokens")}
              value={
                summary && summary.cacheWriteObservedRequestCount > 0
                  ? formatTokens(summary.cacheWriteTokens)
                  : "—"
              }
            />
          </div>

          <Card>
            <CardHeader>
              <CardTitle>{t("usage.cacheTrend", { granularity: granLabel })}</CardTitle>
            </CardHeader>
            <CardContent>
              {trend.length === 0 ? (
                <div className="text-muted-foreground flex h-64 items-center justify-center text-sm">
                  {t("usage.noData")}
                </div>
              ) : (
                <ResponsiveContainer width="100%" height={260}>
                  <LineChart data={trend}>
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
                    <YAxis
                      domain={[0, 1]}
                      tickFormatter={(value: number) => percentFormatter.format(value)}
                      className="text-xs"
                    />
                    <Tooltip
                      formatter={(value) => percentFormatter.format(Number(value))}
                      labelFormatter={(label) => dateTimeFormatter.format(new Date(String(label)))}
                    />
                    <Legend />
                    <Line
                      type="monotone"
                      dataKey="cacheTokenHitRate"
                      name={t("usage.cacheTokenHitRate")}
                      stroke="#22c55e"
                      connectNulls={false}
                    />
                    <Line
                      type="monotone"
                      dataKey="cacheRequestHitRate"
                      name={t("usage.cacheRequestHitRate")}
                      stroke="#14b8a6"
                      connectNulls={false}
                    />
                    <Line
                      type="monotone"
                      dataKey="cacheObservationRate"
                      name={t("usage.cacheObservationRate")}
                      stroke="#a855f7"
                      strokeDasharray="5 5"
                    />
                  </LineChart>
                </ResponsiveContainer>
              )}
            </CardContent>
          </Card>
        </section>
      )}

      <Card>
        <CardHeader>
          <CardTitle>{t("usage.dailyActivity")}</CardTitle>
          <p className="text-muted-foreground text-sm">{t("usage.dailyActivityScope")}</p>
        </CardHeader>
        <CardContent>
          {heatmapLoading ? (
            <div role="status" className="text-muted-foreground py-8 text-center text-sm">
              {t("usage.loading")}
            </div>
          ) : heatmapError ? (
            <LoadError
              message={t("usage.heatmapLoadError")}
              onRetry={() => setHeatmapRetry((n) => n + 1)}
            />
          ) : (
            <TokenHeatmap data={heatmapData} />
          )}
        </CardContent>
      </Card>
    </div>
  );
}
