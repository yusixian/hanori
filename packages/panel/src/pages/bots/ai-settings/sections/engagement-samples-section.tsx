import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Pagination } from "@/components/ui/pagination";
import { Select } from "@/components/ui/select";
import { client } from "@/lib/client";
import type { EngagementContextMessage, EngagementLabel } from "@cos-tool-bot/shared";
import type { InferResponseType } from "hono/client";
import { AlertCircle, ChevronDown, Clock3, Inbox, Loader2, RotateCw } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

const PAGE_SIZE = 20;

type EngagementSamplesEndpoint = (typeof client.api.bots)[":botId"]["engagement-samples"];
type EngagementSamplesResponse = InferResponseType<EngagementSamplesEndpoint["$get"], 200>;
type EngagementSampleRow = EngagementSamplesResponse["items"][number];
type ReviewLabel = EngagementLabel | null;

type FilterState = {
  chatId: string;
  mode: "" | "off" | "shadow" | "active";
  choice: "" | "continue" | "join" | "silent";
  engagement: "" | "answer" | "silent";
  actualOutcome: "" | "answer" | "silent";
  actualTrigger: string;
  errorCategory: string;
  configVersion: string;
  decisionFormat: "" | "two_stage" | "legacy";
  label: "" | "answer" | "silent" | "uncertain" | "unreviewed";
  createdFrom: string;
  createdTo: string;
};

const EMPTY_FILTERS: FilterState = {
  chatId: "",
  mode: "",
  choice: "",
  engagement: "",
  actualOutcome: "",
  actualTrigger: "",
  errorCategory: "",
  configVersion: "",
  decisionFormat: "",
  label: "",
  createdFrom: "",
  createdTo: "",
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
  const [hasLoaded, setHasLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [filterError, setFilterError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [selectedIds, setSelectedIds] = useState<Set<number>>(() => new Set());
  const [writeInFlight, setWriteInFlight] = useState(false);
  const [presentedCollectionKey, setPresentedCollectionKey] = useState<string | null>(null);
  const requestId = useRef(0);
  const activeBotId = useRef(botId);
  const composingText = useRef(false);
  const collectionKey = `${botId}:${page}:${JSON.stringify(settledFilters)}`;
  const collectionKeyRef = useRef(collectionKey);
  collectionKeyRef.current = collectionKey;

  const locale = i18n.resolvedLanguage ?? i18n.language;
  const dateFormatter = useMemo(
    () => new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short" }),
    [locale],
  );

  const clearSelection = useCallback(() => setSelectedIds(new Set()), []);

  useEffect(() => {
    activeBotId.current = botId;
    requestId.current += 1;
    clearSelection();
    setItems([]);
    setTotal(0);
    setMetrics(undefined);
    setPresentedCollectionKey(null);
    setPage(1);
    setFilters(EMPTY_FILTERS);
    setSettledFilters(EMPTY_FILTERS);
    setError(null);
    setFilterError(null);
    setStatus(null);
    setWriteInFlight(false);
    setHasLoaded(false);
    setLoading(true);
  }, [botId, clearSelection]);

  const settleFilters = useCallback(
    (next: FilterState) => {
      const validationError = validateFilters(next, t);
      setFilterError(validationError);
      if (validationError) return false;
      clearSelection();
      setPage(1);
      setSettledFilters(next);
      return true;
    },
    [clearSelection, t],
  );

  useEffect(() => {
    if (composingText.current) return;
    if (
      filters.chatId === settledFilters.chatId &&
      filters.actualTrigger === settledFilters.actualTrigger &&
      filters.errorCategory === settledFilters.errorCategory &&
      filters.configVersion === settledFilters.configVersion
    ) {
      return;
    }
    const timeout = window.setTimeout(() => {
      settleFilters(filters);
    }, 300);
    return () => window.clearTimeout(timeout);
  }, [
    filters.chatId,
    filters.actualTrigger,
    filters.errorCategory,
    filters.configVersion,
    settleFilters,
  ]);

  const load = useCallback(async () => {
    if (!botId || filterError) return;
    const requestedBotId = botId;
    const requestedCollection = collectionKey;
    const currentRequest = ++requestId.current;
    setLoading(true);
    setError(null);

    const query: Record<string, string> = { page: String(page), pageSize: String(PAGE_SIZE) };
    for (const [key, value] of Object.entries(settledFilters)) {
      if (!value) continue;
      if (key === "createdFrom" || key === "createdTo") query[key] = localDateTimeToIso(value);
      else query[key] = value;
    }

    try {
      const response = await client.api.bots[":botId"]["engagement-samples"].$get({
        param: { botId: requestedBotId },
        query,
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const payload = await response.json();
      if (!payload.ok) throw new Error("Request failed");
      if (currentRequest !== requestId.current || activeBotId.current !== requestedBotId) return;

      const lastPage = Math.max(1, Math.ceil(payload.total / PAGE_SIZE));
      if (page > lastPage) {
        clearSelection();
        setItems([]);
        setPresentedCollectionKey(null);
        setPage(lastPage);
        return;
      }
      setItems(payload.items);
      const visibleIds = new Set(payload.items.map((item) => item.id));
      setSelectedIds((current) => new Set([...current].filter((id) => visibleIds.has(id))));
      setTotal(payload.total);
      setMetrics(payload.metrics);
      setPresentedCollectionKey(requestedCollection);
      setHasLoaded(true);
    } catch {
      if (currentRequest !== requestId.current || activeBotId.current !== requestedBotId) return;
      setItems([]);
      setTotal(0);
      setMetrics(undefined);
      setPresentedCollectionKey(null);
      clearSelection();
      setError(t("engagementSamples.loadError"));
      setHasLoaded(true);
    } finally {
      if (currentRequest === requestId.current && activeBotId.current === requestedBotId) {
        setLoading(false);
      }
    }
  }, [botId, clearSelection, collectionKey, filterError, page, settledFilters, t]);
  const loadRef = useRef(load);
  loadRef.current = load;

  useEffect(() => {
    void load();
  }, [load]);

  const updateFilter = <K extends keyof FilterState>(key: K, value: FilterState[K]) => {
    const next = { ...filters, [key]: value };
    clearSelection();
    setFilters(next);
    if (
      key !== "chatId" &&
      key !== "actualTrigger" &&
      key !== "errorCategory" &&
      key !== "configVersion"
    ) {
      settleFilters(next);
    }
  };

  const handleCompositionEnd = (
    key: "chatId" | "actualTrigger" | "errorCategory" | "configVersion",
    value: string,
  ) => {
    composingText.current = false;
    const next = { ...filters, [key]: value };
    clearSelection();
    setFilters(next);
    settleFilters(next);
  };

  const hasFilters = Object.values(filters).some(Boolean);
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const selectableIds = items.map((item) => item.id).filter((id): id is number => id > 0);
  const selectedOnPage = selectableIds.filter((id) => selectedIds.has(id));
  const allSelected = selectableIds.length > 0 && selectedOnPage.length === selectableIds.length;
  const partiallySelected = selectedOnPage.length > 0 && !allSelected;
  const currentFilterError = validateFilters(filters, t);
  const filtersMatchSettled = filterStatesEqual(filters, settledFilters);
  const presentedCollectionMatches = presentedCollectionKey === collectionKey;
  const reviewActionsDisabled =
    writeInFlight ||
    loading ||
    Boolean(currentFilterError) ||
    !filtersMatchSettled ||
    !presentedCollectionMatches;
  const waitingForFilteredResults =
    hasLoaded && !currentFilterError && (!filtersMatchSettled || !presentedCollectionMatches);

  const clearFilters = () => {
    clearSelection();
    setFilters(EMPTY_FILTERS);
    setSettledFilters(EMPTY_FILTERS);
    setFilterError(null);
    setPage(1);
  };

  const applySavedLabel = useCallback(
    (updatedIds: readonly number[], label: ReviewLabel) => {
      const updated = new Set(updatedIds);
      setItems((current) =>
        current
          .map((row) => (updated.has(row.id) ? { ...row, label } : row))
          .filter((row) => rowMatchesLabelFilter(row, settledFilters.label)),
      );
      setSelectedIds((current) => {
        const next = new Set(current);
        for (const id of updatedIds) next.delete(id);
        return next;
      });
    },
    [settledFilters.label],
  );

  const saveLabels = async (ids: number[], label: ReviewLabel) => {
    if (ids.length === 0 || reviewActionsDisabled) return;
    const requestedBotId = botId;
    const requestedCollection = collectionKeyRef.current;
    setWriteInFlight(true);
    setError(null);
    setStatus(null);
    try {
      const response = await client.api.bots[":botId"]["engagement-samples"].$patch({
        param: { botId: requestedBotId },
        json: { ids, label },
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const payload = await response.json();
      if (!payload.ok) throw new Error("Request failed");
      if (activeBotId.current !== requestedBotId) return;
      if (collectionKeyRef.current === requestedCollection) {
        applySavedLabel(payload.ids, label);
        setStatus(
          payload.count === ids.length
            ? t("engagementSamples.batchSuccess", { count: payload.count })
            : t("engagementSamples.batchPartial", {
                updated: payload.count,
                requested: ids.length,
              }),
        );
      }
      await loadRef.current();
    } catch {
      if (activeBotId.current === requestedBotId) setError(t("engagementSamples.labelError"));
    } finally {
      if (activeBotId.current === requestedBotId) setWriteInFlight(false);
    }
  };

  const saveLabel = async (row: EngagementSampleRow, label: ReviewLabel) => {
    if (!row.id || reviewActionsDisabled) return;
    const requestedBotId = botId;
    const requestedCollection = collectionKeyRef.current;
    setWriteInFlight(true);
    setError(null);
    setStatus(null);
    try {
      const response = await client.api.bots[":botId"]["engagement-samples"][":sampleId"].$patch({
        param: { botId: requestedBotId, sampleId: String(row.id) },
        json: { label },
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const payload = await response.json();
      if (!payload.ok) throw new Error("Request failed");
      if (activeBotId.current !== requestedBotId) return;
      if (collectionKeyRef.current === requestedCollection) {
        applySavedLabel([row.id], label);
        setStatus(t("engagementSamples.singleSuccess"));
      }
      await loadRef.current();
    } catch {
      if (activeBotId.current === requestedBotId) setError(t("engagementSamples.labelError"));
    } finally {
      if (activeBotId.current === requestedBotId) setWriteInFlight(false);
    }
  };

  const setPageSafely = (nextPage: number) => {
    clearSelection();
    setPage(nextPage);
  };

  return (
    <Card>
      <CardHeader className="pb-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="space-y-1.5">
            <CardTitle className="text-base">{t("engagementSamples.title")}</CardTitle>
            <CardDescription>{t("engagementSamples.description")}</CardDescription>
          </div>
          <Badge variant="muted">
            {t("engagementSamples.labeledCount", { count: metrics?.labeledCount ?? 0 })}
          </Badge>
        </div>
      </CardHeader>
      <CardContent className="min-w-0 space-y-4">
        <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
          <Input
            value={filters.chatId}
            onChange={(event) => updateFilter("chatId", event.target.value)}
            onCompositionStart={() => {
              composingText.current = true;
            }}
            onCompositionEnd={(event) => handleCompositionEnd("chatId", event.currentTarget.value)}
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
            value={filters.decisionFormat}
            onChange={(event) =>
              updateFilter("decisionFormat", event.target.value as FilterState["decisionFormat"])
            }
            aria-label={t("engagementSamples.filters.decisionFormat")}
          >
            <option value="">{t("engagementSamples.filters.allDecisionFormats")}</option>
            <option value="two_stage">{t("engagementSamples.formats.twoStage")}</option>
            <option value="legacy">{t("engagementSamples.formats.legacy")}</option>
          </Select>
          <Select
            value={filters.engagement}
            onChange={(event) =>
              updateFilter("engagement", event.target.value as FilterState["engagement"])
            }
            aria-label={t("engagementSamples.filters.engagement")}
          >
            <option value="">{t("engagementSamples.filters.allEngagements")}</option>
            <option value="answer">{t("engagementSamples.admissions.answer")}</option>
            <option value="silent">{t("engagementSamples.admissions.silent")}</option>
          </Select>
          <Select
            value={filters.actualOutcome}
            onChange={(event) =>
              updateFilter("actualOutcome", event.target.value as FilterState["actualOutcome"])
            }
            aria-label={t("engagementSamples.filters.actualOutcome")}
          >
            <option value="">{t("engagementSamples.filters.allActualOutcomes")}</option>
            <option value="answer">{t("engagementSamples.actualOutcomes.answer")}</option>
            <option value="silent">{t("engagementSamples.actualOutcomes.silent")}</option>
          </Select>
          <Select
            value={filters.label}
            onChange={(event) => updateFilter("label", event.target.value as FilterState["label"])}
            aria-label={t("engagementSamples.filters.label")}
          >
            <option value="">{t("engagementSamples.filters.allLabels")}</option>
            <option value="unreviewed">{t("engagementSamples.labels.unreviewed")}</option>
            <option value="answer">{t("engagementSamples.labels.answer")}</option>
            <option value="silent">{t("engagementSamples.labels.silent")}</option>
            <option value="uncertain">{t("engagementSamples.labels.uncertain")}</option>
          </Select>
        </div>

        <details className="group rounded-lg border bg-slate-50/60 px-3 py-2">
          <summary className="flex cursor-pointer list-none items-center gap-1.5 text-xs font-medium [&::-webkit-details-marker]:hidden">
            <ChevronDown className="size-3.5 transition-transform group-open:rotate-180" />
            {t("engagementSamples.moreFilters")}
          </summary>
          <div className="mt-3 grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
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
            <Input
              value={filters.actualTrigger}
              maxLength={100}
              onChange={(event) => updateFilter("actualTrigger", event.target.value)}
              onCompositionStart={() => {
                composingText.current = true;
              }}
              onCompositionEnd={(event) =>
                handleCompositionEnd("actualTrigger", event.currentTarget.value)
              }
              placeholder={t("engagementSamples.filters.actualTrigger")}
              aria-label={t("engagementSamples.filters.actualTrigger")}
            />
            <Input
              value={filters.errorCategory}
              maxLength={100}
              onChange={(event) => updateFilter("errorCategory", event.target.value)}
              onCompositionStart={() => {
                composingText.current = true;
              }}
              onCompositionEnd={(event) =>
                handleCompositionEnd("errorCategory", event.currentTarget.value)
              }
              placeholder={t("engagementSamples.filters.errorCategory")}
              aria-label={t("engagementSamples.filters.errorCategory")}
            />
            <Input
              value={filters.configVersion}
              maxLength={100}
              onChange={(event) => updateFilter("configVersion", event.target.value)}
              onCompositionStart={() => {
                composingText.current = true;
              }}
              onCompositionEnd={(event) =>
                handleCompositionEnd("configVersion", event.currentTarget.value)
              }
              placeholder={t("engagementSamples.filters.configVersion")}
              aria-label={t("engagementSamples.filters.configVersion")}
            />
            <label className="space-y-1 text-xs">
              <span className="text-muted-foreground">{t("engagementSamples.filters.from")}</span>
              <Input
                type="datetime-local"
                value={filters.createdFrom}
                onChange={(event) => updateFilter("createdFrom", event.target.value)}
              />
            </label>
            <label className="space-y-1 text-xs">
              <span className="text-muted-foreground">{t("engagementSamples.filters.to")}</span>
              <Input
                type="datetime-local"
                value={filters.createdTo}
                onChange={(event) => updateFilter("createdTo", event.target.value)}
              />
            </label>
            <p className="text-muted-foreground self-end text-[11px] leading-4">
              {t("engagementSamples.timeFilterHelp")}
            </p>
          </div>
        </details>

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

        {currentFilterError && (
          <p role="alert" className="text-destructive text-sm">
            {currentFilterError}
          </p>
        )}

        {waitingForFilteredResults && (
          <p role="status" className="text-muted-foreground text-xs">
            {t("engagementSamples.filterPending")}
          </p>
        )}

        {metrics && <MetricsSummary metrics={metrics} />}

        {(error || status) && (
          <div
            role={error ? "alert" : "status"}
            className={`flex items-start gap-2 rounded-lg border px-3 py-2.5 text-sm ${
              error
                ? "border-red-200 bg-red-50 text-red-700"
                : "border-emerald-200 bg-emerald-50 text-emerald-800"
            }`}
          >
            {error && <AlertCircle className="mt-0.5 size-4 shrink-0" aria-hidden="true" />}
            <span className="flex-1">{error ?? status}</span>
            {error && (
              <Button
                variant="ghost"
                size="icon"
                className="-my-1 -mr-1 text-red-700"
                onClick={() => void load()}
                aria-label={t("engagementSamples.retry")}
              >
                <RotateCw className="size-4" aria-hidden="true" />
              </Button>
            )}
          </div>
        )}

        {items.length > 0 && (
          <div className="sticky top-0 z-10 flex flex-wrap items-center gap-2 rounded-lg border bg-white/95 px-3 py-2 shadow-sm backdrop-blur">
            <Checkbox
              checked={allSelected ? true : partiallySelected ? "indeterminate" : false}
              disabled={reviewActionsDisabled}
              onCheckedChange={(checked) =>
                setSelectedIds(checked === true ? new Set(selectableIds) : new Set())
              }
              aria-label={t("engagementSamples.selectPage")}
            />
            <span className="mr-auto text-xs font-medium">
              {t("engagementSamples.selectedCount", { count: selectedIds.size })}
            </span>
            <ReviewButtons
              disabled={selectedIds.size === 0 || reviewActionsDisabled}
              onChange={(label) => void saveLabels([...selectedIds], label)}
            />
            {writeInFlight && (
              <Loader2 className="size-4 animate-spin" aria-label={t("engagementSamples.saving")} />
            )}
          </div>
        )}

        {!hasLoaded && loading ? (
          <div
            role="status"
            className="text-muted-foreground flex items-center justify-center gap-2 py-14 text-sm"
          >
            <Loader2 className="size-4 animate-spin" aria-hidden="true" />
            {t("engagementSamples.loading")}
          </div>
        ) : items.length === 0 && !error ? (
          <div className="text-muted-foreground flex flex-col items-center gap-2 rounded-xl border border-dashed py-14 text-center text-sm">
            <Inbox className="size-7" aria-hidden="true" />
            <p>
              {hasFilters ? t("engagementSamples.emptyFiltered") : t("engagementSamples.empty")}
            </p>
          </div>
        ) : (
          <div className="relative space-y-2" aria-live="polite" aria-busy={loading}>
            {loading && hasLoaded && (
              <span className="text-muted-foreground absolute -top-7 right-0 inline-flex items-center gap-1 text-xs">
                <Loader2 className="size-3 animate-spin" /> {t("engagementSamples.refreshing")}
              </span>
            )}
            {items.map((item) => (
              <EngagementSampleRowView
                key={sampleKey(item)}
                row={item}
                dateFormatter={dateFormatter}
                selected={selectedIds.has(item.id)}
                disabled={reviewActionsDisabled}
                onSelectedChange={(checked) =>
                  setSelectedIds((current) => {
                    const next = new Set(current);
                    if (checked) next.add(item.id);
                    else next.delete(item.id);
                    return next;
                  })
                }
                onLabelChange={(label) => void saveLabel(item, label)}
                onConfigFilter={(configVersion) => updateFilter("configVersion", configVersion)}
              />
            ))}
          </div>
        )}

        <Pagination page={page} totalPages={totalPages} onPageChange={setPageSafely} />
      </CardContent>
    </Card>
  );
}

function MetricsSummary({ metrics }: { metrics: EngagementSamplesResponse["metrics"] }) {
  const { t } = useTranslation("aiSettings");
  const evaluation = metrics.evaluationByFormat;
  return (
    <div className="space-y-2 rounded-lg border bg-slate-50 px-3 py-2.5 text-xs">
      <dl className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
        <Metric label={t("engagementSamples.records")} value={String(metrics.total ?? 0)} />
        <Metric
          label={t("engagementSamples.errorsAndTimeouts")}
          value={t("engagementSamples.errorTimeoutValue", {
            errors: metrics.errorCount ?? 0,
            timeouts: metrics.timeoutCount ?? 0,
          })}
        />
        <Metric
          label={t("engagementSamples.p95Latency")}
          value={
            metrics.latencyP95Ms === null || metrics.latencyP95Ms === undefined
              ? t("engagementSamples.notAvailable")
              : t("engagementSamples.latency", { value: metrics.latencyP95Ms })
          }
        />
        <Metric
          label={t("engagementSamples.classifierCost")}
          value={
            metrics.classifierCostUnknownCount
              ? t("engagementSamples.partialClassifierCost", {
                  cost: metrics.classifierCostKnownCount
                    ? formatUsd(metrics.classifierCostUsd ?? 0)
                    : t("engagementSamples.notAvailable"),
                  count: metrics.classifierCostUnknownCount,
                })
              : metrics.classifierCostKnownCount
                ? formatUsd(metrics.classifierCostUsd ?? 0)
                : t("engagementSamples.notAvailable")
          }
        />
      </dl>
      <details className="group border-t pt-2">
        <summary className="text-muted-foreground flex cursor-pointer list-none items-center gap-1 font-medium [&::-webkit-details-marker]:hidden">
          <ChevronDown className="size-3.5 transition-transform group-open:rotate-180" />
          {t("engagementSamples.humanEvaluation", { count: metrics.evaluatedCount ?? 0 })}
        </summary>
        {evaluation ? (
          <div className="mt-2 grid gap-2 lg:grid-cols-2">
            <EvaluationGroup
              title={t("engagementSamples.formats.twoStage")}
              metrics={evaluation.twoStage}
            />
            <EvaluationGroup
              title={t("engagementSamples.formats.legacy")}
              metrics={evaluation.legacy}
            />
          </div>
        ) : (
          <p className="text-muted-foreground mt-2 text-[11px]">
            {t("engagementSamples.groupedEvaluationUnavailable")}
          </p>
        )}
        <p className="text-muted-foreground mt-2 text-[11px]">
          {t("engagementSamples.humanEvaluationHelp")}
        </p>
      </details>
      <p className="text-muted-foreground text-[11px]">
        {t("engagementSamples.classifierCostOnly")}
      </p>
    </div>
  );
}

function EvaluationGroup({
  title,
  metrics,
}: {
  title: string;
  metrics: EngagementSamplesResponse["metrics"]["evaluationByFormat"]["twoStage"];
}) {
  const { t } = useTranslation("aiSettings");
  return (
    <section className="rounded-md border bg-white p-2">
      <h4 className="font-medium">{title}</h4>
      <p className="text-muted-foreground mt-0.5 text-[11px]">
        {t("engagementSamples.evaluationCoverage", {
          evaluated: metrics.evaluatedCount,
          labeled: metrics.labeledCount,
          total: metrics.sampleCount,
          unreviewed: Math.max(0, metrics.sampleCount - metrics.labeledCount),
        })}
      </p>
      <dl className="mt-2 grid grid-cols-2 gap-2">
        <Metric
          label={t("engagementSamples.falsePositive")}
          value={formatMetricFraction(metrics.falsePositiveCount, metrics.labelSilentCount)}
        />
        <Metric
          label={t("engagementSamples.falseNegative")}
          value={formatMetricFraction(metrics.falseNegativeCount, metrics.labelAnswerCount)}
        />
      </dl>
    </section>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="text-foreground mt-0.5 font-medium tabular-nums">{value}</dd>
    </div>
  );
}

function EngagementSampleRowView({
  row,
  dateFormatter,
  selected,
  disabled,
  onSelectedChange,
  onLabelChange,
  onConfigFilter,
}: {
  row: EngagementSampleRow;
  dateFormatter: Intl.DateTimeFormat;
  selected: boolean;
  disabled: boolean;
  onSelectedChange: (checked: boolean) => void;
  onLabelChange: (label: ReviewLabel) => void;
  onConfigFilter: (configVersion: string) => void;
}) {
  const { t } = useTranslation("aiSettings");
  const expired = isContextExpired(row);
  const context = Array.isArray(row.context) ? row.context : [];
  const currentMessage = context.find((message) => message.messageId === row.messageId);
  const createdAt = getCreatedAt(row);
  const hasReplyDecision = row.probabilities?.answer !== undefined;
  const probability = (key: string) => {
    const value = row.probabilities?.[key];
    return value === undefined ? t("engagementSamples.notAvailable") : formatConfidence(value);
  };

  return (
    <article className="min-w-0 rounded-xl border bg-white px-3 py-3 shadow-sm sm:px-4">
      <div className="flex min-w-0 items-start gap-2.5">
        <Checkbox
          checked={selected}
          disabled={disabled || row.id <= 0}
          onCheckedChange={(checked) => onSelectedChange(checked === true)}
          aria-label={t("engagementSamples.selectMessage", { messageId: row.messageId })}
          className="mt-0.5"
        />
        <div className="min-w-0 flex-1 space-y-2.5">
          <div className="flex min-w-0 flex-wrap items-start justify-between gap-2">
            <div className="flex min-w-0 flex-wrap items-center gap-1.5">
              <Badge variant={row.engagement === "answer" ? "success" : "muted"}>
                {t(`engagementSamples.admissions.${row.engagement}`)}
              </Badge>
              <Badge variant={row.actualTrigger ? "success" : "muted"}>
                {t(`engagementSamples.actualOutcomes.${row.actualTrigger ? "answer" : "silent"}`)}
              </Badge>
              <Badge variant="muted">{decisionLabel(row, hasReplyDecision, t)}</Badge>
              {expired && <Badge variant="warning">{t("engagementSamples.expired")}</Badge>}
              {row.errorCategory && <Badge variant="destructive">{row.errorCategory}</Badge>}
            </div>
            {createdAt && (
              <time
                dateTime={createdAt}
                className="text-muted-foreground shrink-0 text-xs tabular-nums"
              >
                {formatDate(dateFormatter, createdAt)}
              </time>
            )}
          </div>

          <p
            data-testid="engagement-message-summary"
            className="line-clamp-3 text-sm leading-5 [overflow-wrap:anywhere] whitespace-pre-wrap"
          >
            {expired
              ? t("engagementSamples.currentMessageExpired")
              : (currentMessage?.text ?? t("engagementSamples.currentMessageUnavailable"))}
          </p>

          <div className="text-muted-foreground flex min-w-0 flex-wrap gap-x-3 gap-y-1 text-xs">
            <span>{t("engagementSamples.chat", { chatId: row.chatId })}</span>
            <span>{t("engagementSamples.message", { messageId: row.messageId })}</span>
            <span className="min-w-0 break-words">
              {t("engagementSamples.reason")}: {formatReason(row, hasReplyDecision, t)}
            </span>
          </div>

          <div className="flex flex-wrap items-center justify-between gap-2 border-t pt-2.5">
            <Badge variant={row.label ? "success" : "muted"}>
              {t(`engagementSamples.labels.${row.label ?? "unreviewed"}`)}
            </Badge>
            <ReviewButtons
              current={row.label}
              disabled={disabled || row.id <= 0}
              onChange={onLabelChange}
            />
          </div>

          <details className="group">
            <summary className="text-muted-foreground flex cursor-pointer list-none items-center gap-1 py-1 text-xs font-medium [&::-webkit-details-marker]:hidden">
              <ChevronDown className="size-3.5 transition-transform group-open:rotate-180" />
              {t("engagementSamples.details")}
            </summary>
            <div className="mt-2 min-w-0 space-y-3 rounded-lg bg-slate-50 px-3 py-2 text-xs">
              <div className="text-muted-foreground flex flex-wrap gap-x-3 gap-y-1 text-[11px]">
                <span className="inline-flex items-center gap-1">
                  <Clock3 className="size-3" aria-hidden="true" />
                  {t("engagementSamples.latency", { value: row.latencyMs })}
                </span>
                <span>
                  {t("engagementSamples.mode", { value: t(`engagementSamples.modes.${row.mode}`) })}
                </span>
                {row.model && <span>{t("engagementSamples.model", { value: row.model })}</span>}
                {row.configVersion && (
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="h-auto max-w-full px-1 py-0 text-[11px] font-normal"
                    onClick={() => onConfigFilter(row.configVersion)}
                    title={t("engagementSamples.filterByConfig")}
                  >
                    <span className="truncate">
                      {t("engagementSamples.config", { value: row.configVersion })}
                    </span>
                  </Button>
                )}
                {row.source && <span>{t("engagementSamples.source", { value: row.source })}</span>}
                {row.inputTokens !== null && row.inputTokens !== undefined && (
                  <span>{t("engagementSamples.tokens", { value: row.inputTokens })}</span>
                )}
                {row.estimatedCostUsd !== null && row.estimatedCostUsd !== undefined && (
                  <span>
                    {t("engagementSamples.cost", { value: formatUsd(row.estimatedCostUsd) })}
                  </span>
                )}
              </div>

              {hasReplyDecision && (
                <div className="text-muted-foreground space-y-1 text-[11px]">
                  <p className="text-foreground font-medium">
                    {row.participation
                      ? t("engagementSamples.rawParticipation", {
                          choice: t(
                            `engagementSamples.participationNames.${row.participation.choice}`,
                          ),
                          confidence: formatConfidence(row.participation.confidence),
                        })
                      : t("engagementSamples.rawParticipationUnavailable")}
                  </p>
                  <p>{t("engagementSamples.participationHelp")}</p>
                </div>
              )}

              {row.probabilities &&
                (hasReplyDecision ? (
                  <div className="space-y-1 text-[11px]">
                    <div className="text-muted-foreground flex flex-wrap items-center gap-x-3 gap-y-1">
                      <span className="text-foreground font-medium">
                        {t("engagementSamples.replyProbabilities")}
                      </span>
                      <span>
                        {t("engagementSamples.replyChoices.answer", {
                          value: probability("answer"),
                        })}
                      </span>
                      <span>
                        {t("engagementSamples.replyChoices.silent", {
                          value: probability("silent"),
                        })}
                      </span>
                    </div>
                    <div className="text-muted-foreground flex flex-wrap items-center gap-x-3 gap-y-1">
                      <span className="text-foreground font-medium">
                        {t("engagementSamples.participationProbabilities")}
                      </span>
                      <span>
                        {t("engagementSamples.participationChoices.addressed", {
                          value: probability("addressed"),
                        })}
                      </span>
                      <span>
                        {t("engagementSamples.participationChoices.continue", {
                          value: probability("continue"),
                        })}
                      </span>
                      <span>
                        {t("engagementSamples.participationChoices.join", {
                          value: probability("join"),
                        })}
                      </span>
                    </div>
                  </div>
                ) : (
                  <div className="text-muted-foreground flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px]">
                    <span className="text-foreground font-medium">
                      {t("engagementSamples.legacyProbabilities")}
                    </span>
                    {(["continue", "join", "silent"] as const).map((choice) => (
                      <span key={choice}>
                        {t(`engagementSamples.choices.${choice}`)} {probability(choice)}
                      </span>
                    ))}
                  </div>
                ))}

              <div className="space-y-2 border-t pt-2">
                <p className="text-foreground font-medium">
                  {t("engagementSamples.contextDetails")}
                </p>
                {expired ? (
                  <p className="text-muted-foreground">{t("engagementSamples.contextExpired")}</p>
                ) : context.length > 0 ? (
                  context.map((message) => (
                    <ContextMessage
                      key={`${message.messageId}-${message.timestamp}`}
                      message={message}
                    />
                  ))
                ) : (
                  <p className="text-muted-foreground">
                    {t("engagementSamples.contextUnavailable")}
                  </p>
                )}
                {row.configSnapshot && (
                  <ConfigSnapshot
                    snapshot={row.configSnapshot}
                    hasReplyDecision={hasReplyDecision}
                  />
                )}
              </div>
            </div>
          </details>
        </div>
      </div>
    </article>
  );
}

function ReviewButtons({
  current,
  disabled,
  onChange,
}: {
  current?: EngagementLabel | null;
  disabled: boolean;
  onChange: (label: ReviewLabel) => void;
}) {
  const { t } = useTranslation("aiSettings");
  const choices: Array<{ label: ReviewLabel; key: "answer" | "silent" | "uncertain" | "clear" }> = [
    { label: "answer", key: "answer" },
    { label: "silent", key: "silent" },
    { label: "uncertain", key: "uncertain" },
    { label: null, key: "clear" },
  ];
  return (
    <div
      className="flex max-w-full flex-wrap gap-1.5"
      role="group"
      aria-label={t("engagementSamples.reviewActions")}
    >
      {choices.map((choice) => (
        <Button
          key={choice.key}
          type="button"
          size="sm"
          variant={
            choice.label !== null && current !== undefined && current === choice.label
              ? "default"
              : "outline"
          }
          className="h-8 px-2.5 text-xs"
          aria-pressed={current !== undefined ? current === choice.label : undefined}
          disabled={disabled || (choice.label === null && current === null)}
          onClick={() => onChange(choice.label)}
        >
          {t(`engagementSamples.labels.${choice.key}`)}
        </Button>
      ))}
    </div>
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

function ConfigSnapshot({
  snapshot,
  hasReplyDecision,
}: {
  snapshot: object;
  hasReplyDecision: boolean;
}) {
  const { t } = useTranslation("aiSettings");
  const snapshotRecord = snapshot as Record<string, unknown>;
  const missingRoutingSettings =
    hasReplyDecision &&
    [
      "addressedConfidenceThreshold",
      "continueConfidenceThreshold",
      "continuationWindowSeconds",
    ].some((key) => !(key in snapshotRecord));
  const visibleEntries = Object.entries(snapshot).filter(
    ([key]) => key !== "apiKey" && !key.toLowerCase().includes("secret"),
  );
  if (visibleEntries.length === 0) return null;
  return (
    <div className="text-muted-foreground mt-2 space-y-1 border-t pt-2 text-[11px] break-words">
      <p>
        <span className="text-foreground font-medium">{t("engagementSamples.configSnapshot")}</span>{" "}
        <span>
          {visibleEntries
            .map(([key, value]) => {
              const translatedKeys = new Set([
                "confidenceThreshold",
                "addressedConfidenceThreshold",
                "continueConfidenceThreshold",
                "continuationWindowSeconds",
              ]);
              const label = translatedKeys.has(key)
                ? t(`engagementSamples.configSnapshotFields.${key}`)
                : key;
              return `${label}: ${String(value)}`;
            })
            .join(" · ")}
        </span>
      </p>
      {missingRoutingSettings && <p>{t("engagementSamples.legacyConfigDefaults")}</p>}
    </div>
  );
}

function validateFilters(filters: FilterState, t: (key: string) => string): string | null {
  if (filters.chatId.trim()) {
    const chatId = Number(filters.chatId);
    if (!Number.isSafeInteger(chatId)) return t("engagementSamples.invalidChatId");
  }
  const from = filters.createdFrom ? new Date(filters.createdFrom) : null;
  const to = filters.createdTo ? new Date(filters.createdTo) : null;
  if ((from && Number.isNaN(from.getTime())) || (to && Number.isNaN(to.getTime()))) {
    return t("engagementSamples.invalidTime");
  }
  if (from && to && from > to) return t("engagementSamples.invalidTimeRange");
  return null;
}

function filterStatesEqual(left: FilterState, right: FilterState): boolean {
  return (Object.keys(left) as Array<keyof FilterState>).every((key) => left[key] === right[key]);
}

function localDateTimeToIso(value: string): string {
  return new Date(value).toISOString();
}

function rowMatchesLabelFilter(row: EngagementSampleRow, filter: FilterState["label"]): boolean {
  if (!filter) return true;
  if (filter === "unreviewed") return row.label === null;
  return row.label === filter;
}

function decisionLabel(
  row: EngagementSampleRow,
  hasReplyDecision: boolean,
  t: (key: string, options?: Record<string, unknown>) => string,
): string {
  const choice = t(`engagementSamples.choices.${row.choice ?? "unknown"}`);
  if (row.source === "local") return t("engagementSamples.localRule", { choice });
  if (hasReplyDecision) {
    const actualRoute = row.actualTrigger?.match(/^engagement_(addressed|continue|join)$/)?.[1];
    if (actualRoute) {
      return t("engagementSamples.actualParticipationRoute", {
        choice: t(`engagementSamples.participationNames.${actualRoute}`),
      });
    }
    return t("engagementSamples.participationChoice", { choice });
  }
  if (row.source === "jev") return t("engagementSamples.legacyChoice", { choice });
  return t("engagementSamples.fallbackChoice", { choice });
}

function formatReason(
  row: EngagementSampleRow,
  hasReplyDecision: boolean,
  t: (key: string, options?: Record<string, unknown>) => string,
): string {
  if (row.reasonCode !== "below_threshold") {
    const knownReasonCodes = new Set([
      "jev_answer",
      "jev_silent",
      "keyword_direct",
      "engagement_cooldown",
      "queue_full",
      "usage_denied",
      "timeout",
      "overloaded",
      "invalid_response",
      "response_too_large",
      "model_mismatch",
    ]);
    if (knownReasonCodes.has(row.reasonCode)) {
      return t(`engagementSamples.reasonCodes.${row.reasonCode}`);
    }
    return row.reasonCode || t("engagementSamples.notAvailable");
  }
  return t(
    hasReplyDecision
      ? "engagementSamples.reasonCodes.belowReplyThreshold"
      : "engagementSamples.reasonCodes.belowLegacyThreshold",
    {
      confidence:
        row.confidence === null || row.confidence === undefined
          ? t("engagementSamples.notAvailable")
          : formatConfidence(row.confidence),
      threshold: formatConfidence(row.configSnapshot.confidenceThreshold),
    },
  );
}

function sampleKey(row: EngagementSampleRow): string {
  return row.id > 0 ? String(row.id) : `${row.chatId}:${row.messageId}`;
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

function formatMetricFraction(
  numerator: number | undefined,
  denominator: number | undefined,
): string {
  return `${numerator ?? 0}/${denominator ?? 0}`;
}

function isContextExpired(row: EngagementSampleRow): boolean {
  if (!row.contextExpiresAt) return row.context === null;
  const expiresAt = Date.parse(row.contextExpiresAt);
  return !Number.isNaN(expiresAt) && expiresAt <= Date.now();
}
