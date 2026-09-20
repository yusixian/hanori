import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Pagination } from "@/components/ui/pagination";
import { Select } from "@/components/ui/select";
import { client } from "@/lib/client";
import type { EngagementContextMessage, EngagementLabel } from "@cos-tool-bot/shared";
import type { InferResponseType } from "hono/client";
import { AlertCircle, ChevronDown, Clock3, Inbox, Loader2, RotateCw, Tag } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

const PAGE_SIZE = 20;

type EngagementSamplesEndpoint = (typeof client.api.bots)[":botId"]["engagement-samples"];
type EngagementSamplesResponse = InferResponseType<EngagementSamplesEndpoint["$get"], 200>;
type EngagementSampleRow = EngagementSamplesResponse["items"][number];

type FilterState = {
  chatId: string;
  mode: "" | "off" | "shadow" | "active";
  choice: "" | "continue" | "join" | "silent";
  actualOutcome: "" | "answer" | "silent";
  actualTrigger: string;
  errorCategory: string;
  label: "" | "answer" | "silent" | "uncertain";
};

const EMPTY_FILTERS: FilterState = {
  chatId: "",
  mode: "",
  choice: "",
  actualOutcome: "",
  actualTrigger: "",
  errorCategory: "",
  label: "",
};

type EngagementSamplesSectionProps = {
  botId: string;
};

export function EngagementSamplesSection({ botId }: EngagementSamplesSectionProps) {
  const { t, i18n } = useTranslation("aiSettings");
  const [filters, setFilters] = useState<FilterState>(EMPTY_FILTERS);
  const [settledFilters, setSettledFilters] = useState<FilterState>(EMPTY_FILTERS);
  const [items, setItems] = useState<EngagementSampleRow[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [metrics, setMetrics] = useState<EngagementSamplesResponse["metrics"]>();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [savingLabel, setSavingLabel] = useState<string | null>(null);
  const requestId = useRef(0);
  const composingText = useRef(false);

  const locale = i18n.resolvedLanguage ?? i18n.language;
  const dateFormatter = useMemo(
    () => new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short" }),
    [locale],
  );

  useEffect(() => {
    if (composingText.current) return;
    const timeout = window.setTimeout(() => {
      setPage(1);
      setSettledFilters((current) => ({
        ...current,
        chatId: filters.chatId,
        actualTrigger: filters.actualTrigger,
        errorCategory: filters.errorCategory,
      }));
    }, 300);
    return () => window.clearTimeout(timeout);
  }, [filters.chatId, filters.actualTrigger, filters.errorCategory]);

  const load = useCallback(async () => {
    if (!botId) return;
    const currentRequest = ++requestId.current;
    setLoading(true);
    setError(null);

    const params = new URLSearchParams({ page: String(page), pageSize: String(PAGE_SIZE) });
    for (const [key, value] of Object.entries(settledFilters)) {
      if (value) params.set(key, value);
    }

    try {
      const response = await client.api.bots[":botId"]["engagement-samples"].$get({
        param: { botId },
        query: Object.fromEntries(params.entries()),
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);

      const payload = await response.json();
      if (!payload.ok) throw new Error("Request failed");

      if (currentRequest !== requestId.current) return;
      setItems(payload.items);
      setTotal(payload.total);
      setMetrics(payload.metrics);
    } catch {
      if (currentRequest !== requestId.current) return;
      setItems([]);
      setTotal(0);
      setMetrics(undefined);
      setError(t("engagementSamples.loadError"));
    } finally {
      if (currentRequest === requestId.current) setLoading(false);
    }
  }, [botId, page, settledFilters, t]);
  const loadRef = useRef(load);
  loadRef.current = load;

  useEffect(() => {
    void load();
  }, [load]);

  const updateFilter = <K extends keyof FilterState>(key: K, value: FilterState[K]) => {
    setFilters((current) => ({ ...current, [key]: value }));
    if (key === "mode" || key === "choice" || key === "actualOutcome" || key === "label") {
      setPage(1);
      setSettledFilters((current) => ({ ...current, [key]: value }));
    }
  };

  const hasFilters = Object.values(filters).some(Boolean);
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  const clearFilters = () => {
    setFilters(EMPTY_FILTERS);
    setSettledFilters(EMPTY_FILTERS);
    setPage(1);
  };

  const saveLabel = async (row: EngagementSampleRow, label: EngagementLabel) => {
    const sampleId = getSampleId(row);
    if (!sampleId) return;
    const key = sampleKey(row);
    setSavingLabel(key);
    setError(null);
    try {
      const response = await client.api.bots[":botId"]["engagement-samples"][":sampleId"].$patch({
        param: { botId, sampleId },
        json: { label },
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      await loadRef.current();
    } catch {
      setError(t("engagementSamples.labelError"));
    } finally {
      setSavingLabel(null);
    }
  };

  return (
    <Card>
      <CardHeader>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="space-y-1.5">
            <CardTitle className="text-base">{t("engagementSamples.title")}</CardTitle>
            <CardDescription>{t("engagementSamples.description")}</CardDescription>
          </div>
          <div className="text-muted-foreground flex items-center gap-2 text-xs">
            <Tag className="size-3.5" aria-hidden="true" />
            <span>
              {t("engagementSamples.labeledCount", { count: metrics?.labeledCount ?? 0 })}
            </span>
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
          <Input
            value={filters.chatId}
            onChange={(event) => updateFilter("chatId", event.target.value)}
            onCompositionStart={() => {
              composingText.current = true;
            }}
            onCompositionEnd={(event) => {
              composingText.current = false;
              const value = event.currentTarget.value;
              setFilters((current) => ({ ...current, chatId: value }));
              setSettledFilters((current) => ({ ...current, chatId: value }));
              setPage(1);
            }}
            placeholder={t("engagementSamples.filters.chatId")}
            aria-label={t("engagementSamples.filters.chatId")}
            inputMode="numeric"
          />
          <Select
            value={filters.mode}
            onChange={(event) => updateFilter("mode", event.target.value as FilterState["mode"])}
            aria-label={t("engagementSamples.filters.mode")}
          >
            <option value="">{t("engagementSamples.filters.allModes")}</option>
            <option value="off">{t("engagementSamples.modes.off")}</option>
            <option value="shadow">{t("engagementSamples.modes.shadow")}</option>
            <option value="active">{t("engagementSamples.modes.active")}</option>
          </Select>
          <Select
            value={filters.choice}
            onChange={(event) =>
              updateFilter("choice", event.target.value as FilterState["choice"])
            }
            aria-label={t("engagementSamples.filters.choice")}
          >
            <option value="">{t("engagementSamples.filters.allChoices")}</option>
            <option value="continue">{t("engagementSamples.choices.continue")}</option>
            <option value="join">{t("engagementSamples.choices.join")}</option>
            <option value="silent">{t("engagementSamples.choices.silent")}</option>
          </Select>
          <Select
            value={filters.actualOutcome}
            onChange={(event) =>
              updateFilter("actualOutcome", event.target.value as FilterState["actualOutcome"])
            }
            aria-label={t("engagementSamples.filters.engagement")}
          >
            <option value="">{t("engagementSamples.filters.allEngagements")}</option>
            <option value="answer">{t("engagementSamples.admissions.answer")}</option>
            <option value="silent">{t("engagementSamples.admissions.silent")}</option>
          </Select>
          <Input
            value={filters.actualTrigger}
            onChange={(event) => updateFilter("actualTrigger", event.target.value)}
            onCompositionStart={() => {
              composingText.current = true;
            }}
            onCompositionEnd={(event) => {
              composingText.current = false;
              const value = event.currentTarget.value;
              setFilters((current) => ({ ...current, actualTrigger: value }));
              setSettledFilters((current) => ({ ...current, actualTrigger: value }));
              setPage(1);
            }}
            placeholder={t("engagementSamples.filters.actualTrigger")}
            aria-label={t("engagementSamples.filters.actualTrigger")}
          />
          <Input
            value={filters.errorCategory}
            onChange={(event) => updateFilter("errorCategory", event.target.value)}
            onCompositionStart={() => {
              composingText.current = true;
            }}
            onCompositionEnd={(event) => {
              composingText.current = false;
              const value = event.currentTarget.value;
              setFilters((current) => ({ ...current, errorCategory: value }));
              setSettledFilters((current) => ({ ...current, errorCategory: value }));
              setPage(1);
            }}
            placeholder={t("engagementSamples.filters.errorCategory")}
            aria-label={t("engagementSamples.filters.errorCategory")}
          />
          <Select
            value={filters.label}
            onChange={(event) => updateFilter("label", event.target.value as FilterState["label"])}
            aria-label={t("engagementSamples.filters.label")}
          >
            <option value="">{t("engagementSamples.filters.allLabels")}</option>
            <option value="answer">{t("engagementSamples.labels.answer")}</option>
            <option value="silent">{t("engagementSamples.labels.silent")}</option>
            <option value="uncertain">{t("engagementSamples.labels.uncertain")}</option>
          </Select>
        </div>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className="text-muted-foreground text-xs">
            {t("engagementSamples.resultCount", { count: total })}
          </p>
          {hasFilters && (
            <Button variant="ghost" size="sm" onClick={clearFilters}>
              {t("engagementSamples.clearFilters")}
            </Button>
          )}
        </div>

        {metrics && (
          <dl className="grid gap-2 rounded-lg border bg-slate-50 px-3 py-2.5 text-xs sm:grid-cols-3">
            <div>
              <dt className="text-muted-foreground">{t("engagementSamples.evaluated")}</dt>
              <dd className="text-foreground mt-0.5 font-medium">{metrics.evaluatedCount ?? 0}</dd>
            </div>
            <div>
              <dt className="text-muted-foreground">{t("engagementSamples.p95Latency")}</dt>
              <dd className="text-foreground mt-0.5 font-medium">
                {metrics.latencyP95Ms === null || metrics.latencyP95Ms === undefined
                  ? t("engagementSamples.notAvailable")
                  : t("engagementSamples.latency", { value: metrics.latencyP95Ms })}
              </dd>
            </div>
            <div>
              <dt className="text-muted-foreground">{t("engagementSamples.classifierCost")}</dt>
              <dd className="text-foreground mt-0.5 font-medium">
                {metrics.classifierCostUnknownCount
                  ? t("engagementSamples.partialClassifierCost", {
                      cost: metrics.classifierCostKnownCount
                        ? formatUsd(metrics.classifierCostUsd ?? 0)
                        : t("engagementSamples.notAvailable"),
                      count: metrics.classifierCostUnknownCount,
                    })
                  : metrics.classifierCostKnownCount
                    ? formatUsd(metrics.classifierCostUsd ?? 0)
                    : t("engagementSamples.notAvailable")}
              </dd>
            </div>
            <div>
              <dt className="text-muted-foreground">{t("engagementSamples.falsePositive")}</dt>
              <dd className="text-foreground mt-0.5 font-medium">
                {formatMetricRate(metrics.falsePositiveCount, metrics.falsePositiveRate)}
              </dd>
            </div>
            <div>
              <dt className="text-muted-foreground">{t("engagementSamples.falseNegative")}</dt>
              <dd className="text-foreground mt-0.5 font-medium">
                {formatMetricRate(metrics.falseNegativeCount, metrics.falseNegativeRate)}
              </dd>
            </div>
            <p className="text-muted-foreground text-[11px] sm:col-span-3">
              {t("engagementSamples.classifierCostOnly")}
            </p>
          </dl>
        )}

        {error && (
          <div
            role="alert"
            className="flex items-start gap-2 rounded-lg border border-red-200 bg-red-50 px-3 py-2.5 text-sm text-red-700"
          >
            <AlertCircle className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
            <span className="flex-1">{error}</span>
            <Button
              variant="ghost"
              size="icon"
              className="-my-1 -mr-1 text-red-700"
              onClick={() => void load()}
              aria-label={t("engagementSamples.retry")}
            >
              <RotateCw className="size-4" aria-hidden="true" />
            </Button>
          </div>
        )}

        {loading ? (
          <div
            role="status"
            className="text-muted-foreground flex items-center justify-center gap-2 py-14 text-sm"
          >
            <Loader2 className="size-4 animate-spin" aria-hidden="true" />
            {t("engagementSamples.loading")}
          </div>
        ) : error ? null : items.length === 0 ? (
          <div className="text-muted-foreground flex flex-col items-center gap-2 rounded-xl border border-dashed py-14 text-center text-sm">
            <Inbox className="size-7" aria-hidden="true" />
            <p>
              {hasFilters ? t("engagementSamples.emptyFiltered") : t("engagementSamples.empty")}
            </p>
          </div>
        ) : (
          <div className="space-y-3" aria-live="polite">
            {items.map((item) => (
              <EngagementSampleRowView
                key={sampleKey(item)}
                row={item}
                dateFormatter={dateFormatter}
                savingLabel={savingLabel === sampleKey(item)}
                onLabelChange={(label) => void saveLabel(item, label)}
              />
            ))}
          </div>
        )}

        <Pagination page={page} totalPages={totalPages} onPageChange={setPage} />
      </CardContent>
    </Card>
  );
}

function EngagementSampleRowView({
  row,
  dateFormatter,
  savingLabel,
  onLabelChange,
}: {
  row: EngagementSampleRow;
  dateFormatter: Intl.DateTimeFormat;
  savingLabel: boolean;
  onLabelChange: (label: EngagementLabel) => void;
}) {
  const { t } = useTranslation("aiSettings");
  const expired = isContextExpired(row);
  const context = Array.isArray(row.context) ? row.context : [];
  const createdAt = getCreatedAt(row);
  const displayLabel = row.label ?? "";
  const sampleId = getSampleId(row);

  return (
    <article className="rounded-xl border bg-white px-3.5 py-3 shadow-sm sm:px-4">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="flex min-w-0 flex-wrap items-center gap-1.5">
          <Badge
            variant={
              row.mode === "active" ? "success" : row.mode === "shadow" ? "warning" : "muted"
            }
          >
            {t(`engagementSamples.modes.${row.mode}`)}
          </Badge>
          <Badge>{t(`engagementSamples.choices.${row.choice ?? "unknown"}`)}</Badge>
          <Badge variant={row.engagement === "answer" ? "success" : "muted"}>
            {t(`engagementSamples.recommendations.${row.engagement}`)}
          </Badge>
          <Badge variant={row.actualTrigger ? "success" : "muted"}>
            {t(`engagementSamples.actualOutcomes.${row.actualTrigger ? "answer" : "silent"}`)}
          </Badge>
          {expired && <Badge variant="warning">{t("engagementSamples.expired")}</Badge>}
          {row.errorCategory && <Badge variant="destructive">{row.errorCategory}</Badge>}
        </div>
        {createdAt && (
          <time dateTime={createdAt} className="text-muted-foreground shrink-0 text-xs">
            {formatDate(dateFormatter, createdAt)}
          </time>
        )}
      </div>

      <div className="text-muted-foreground mt-3 grid gap-2 text-xs sm:grid-cols-2 lg:grid-cols-4">
        <span>{t("engagementSamples.chat", { chatId: row.chatId })}</span>
        <span>{t("engagementSamples.message", { messageId: row.messageId })}</span>
        <span>
          {t("engagementSamples.trigger")}:{" "}
          <strong className="text-foreground font-medium">
            {row.actualTrigger ?? t("engagementSamples.notAvailable")}
          </strong>
        </span>
        <span>
          {t("engagementSamples.confidence")}:{" "}
          <strong className="text-foreground font-medium">
            {row.confidence === null || row.confidence === undefined
              ? t("engagementSamples.notAvailable")
              : formatConfidence(row.confidence)}
          </strong>
        </span>
      </div>

      <div className="text-muted-foreground mt-2 flex flex-wrap gap-x-3 gap-y-1 text-[11px]">
        <span className="inline-flex items-center gap-1">
          <Clock3 className="size-3" aria-hidden="true" />
          {t("engagementSamples.latency", { value: row.latencyMs })}
        </span>
        {row.model && <span>{t("engagementSamples.model", { value: row.model })}</span>}
        {row.configVersion && (
          <span>{t("engagementSamples.config", { value: row.configVersion })}</span>
        )}
        {row.source && <span>{t("engagementSamples.source", { value: row.source })}</span>}
        {row.pricingSource && (
          <span>{t("engagementSamples.pricingSource", { value: row.pricingSource })}</span>
        )}
        {row.inputTokens !== null && row.inputTokens !== undefined && (
          <span>{t("engagementSamples.tokens", { value: row.inputTokens })}</span>
        )}
        {row.estimatedCostUsd !== null && row.estimatedCostUsd !== undefined && (
          <span>{t("engagementSamples.cost", { value: formatUsd(row.estimatedCostUsd) })}</span>
        )}
      </div>

      <div className="mt-3 flex flex-wrap items-center justify-between gap-2 border-t pt-3">
        <div className="flex items-center gap-2 text-xs">
          <span className="text-muted-foreground">{t("engagementSamples.reviewLabel")}</span>
          {sampleId ? (
            <Select
              value={displayLabel}
              disabled={savingLabel}
              onChange={(event) => {
                const value = event.target.value;
                if (value) onLabelChange(value as EngagementLabel);
              }}
              aria-label={t("engagementSamples.reviewLabelFor", { messageId: row.messageId })}
              className="h-9 min-w-32"
            >
              <option value="" disabled>
                {t("engagementSamples.labels.unreviewed")}
              </option>
              <option value="answer">{t("engagementSamples.labels.answer")}</option>
              <option value="silent">{t("engagementSamples.labels.silent")}</option>
              <option value="uncertain">{t("engagementSamples.labels.uncertain")}</option>
            </Select>
          ) : (
            <span className="text-muted-foreground">{t("engagementSamples.unavailable")}</span>
          )}
          {savingLabel && (
            <Loader2
              className="text-muted-foreground size-3.5 animate-spin"
              aria-label={t("engagementSamples.saving")}
            />
          )}
        </div>
        {row.reasonCode && <span className="text-muted-foreground text-xs">{row.reasonCode}</span>}
      </div>

      <details className="group mt-1">
        <summary className="text-muted-foreground flex cursor-pointer list-none items-center gap-1 py-1 text-xs font-medium [&::-webkit-details-marker]:hidden">
          <ChevronDown
            className="size-3.5 transition-transform group-open:rotate-180"
            aria-hidden="true"
          />
          {t("engagementSamples.contextDetails")}
        </summary>
        <div className="mt-2 space-y-2 rounded-lg bg-slate-50 px-3 py-2 text-xs">
          {expired ? (
            <p className="text-muted-foreground">{t("engagementSamples.contextExpired")}</p>
          ) : context.length > 0 ? (
            context.map((message) => (
              <ContextMessage key={`${message.messageId}-${message.timestamp}`} message={message} />
            ))
          ) : (
            <p className="text-muted-foreground">{t("engagementSamples.contextUnavailable")}</p>
          )}
          {row.configSnapshot && <ConfigSnapshot snapshot={row.configSnapshot} />}
        </div>
      </details>
    </article>
  );
}

function ContextMessage({ message }: { message: EngagementContextMessage }) {
  return (
    <p className="leading-5 break-words whitespace-pre-wrap">
      <span className="text-foreground font-medium">{message.isBot ? "Bot" : message.userId}</span>{" "}
      <span className="text-muted-foreground">{message.text}</span>
    </p>
  );
}

function ConfigSnapshot({ snapshot }: { snapshot: object }) {
  const { t } = useTranslation("aiSettings");
  const visibleEntries = Object.entries(snapshot).filter(
    ([key]) => key !== "apiKey" && !key.toLowerCase().includes("secret"),
  );
  if (visibleEntries.length === 0) return null;
  return (
    <div className="text-muted-foreground mt-2 border-t pt-2 text-[11px]">
      <span className="text-foreground font-medium">{t("engagementSamples.configSnapshot")}</span>
      <span className="ml-2">
        {visibleEntries.map(([key, value]) => `${key}: ${String(value)}`).join(" · ")}
      </span>
    </div>
  );
}

function getSampleId(row: EngagementSampleRow): string | null {
  return row.id > 0 ? String(row.id) : null;
}

function sampleKey(row: EngagementSampleRow): string {
  return getSampleId(row) ?? `${row.chatId}:${row.messageId}`;
}

function getCreatedAt(row: EngagementSampleRow): string | null {
  return row.createdAt || null;
}

function formatDate(formatter: Intl.DateTimeFormat, value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : formatter.format(date);
}

function formatConfidence(value: number): string {
  const normalized = value <= 1 ? value * 100 : value;
  return `${Math.round(normalized)}%`;
}

function formatUsd(value: number): string {
  return `$${value.toFixed(value > 0 && value < 0.01 ? 4 : 3)}`;
}

function formatMetricRate(count: number, rate: number | null): string {
  if (rate === null || rate === undefined) return String(count);
  return `${count} (${Math.round(rate * 100)}%)`;
}

function isContextExpired(row: EngagementSampleRow): boolean {
  if (!row.contextExpiresAt) return row.context === null;
  const expiresAt = Date.parse(row.contextExpiresAt);
  return !Number.isNaN(expiresAt) && expiresAt <= Date.now();
}
