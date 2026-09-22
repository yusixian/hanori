import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Pagination } from "@/components/ui/pagination";
import { Select } from "@/components/ui/select";
import { authFetch } from "@/lib/client";
import {
  AlertTriangle,
  Archive,
  CalendarDays,
  ImageOff,
  Loader2,
  RefreshCw,
  Search,
  Sparkles,
  Trash2,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Link, useParams } from "react-router";
import { GenerationGallery, hasNsfwFlag } from "./generation-gallery";
import { GenerationDeleteNotice, type GenerationNoticeKind } from "./generation-delete-notice";
import {
  deleteGeneration,
  type GenerationTarget,
  requireGenerationRead,
  useGenerationResource,
  verifyGenerationTarget,
} from "./generation-resource";
import {
  generationFileUrl,
  isGenerationDeletable,
  type GenerationListItem,
  type GenerationListResponse,
} from "./generation-types";

const PAGE_SIZE = 20;

function isDateString(value: unknown): value is string {
  return typeof value === "string" && !Number.isNaN(Date.parse(value));
}

function isNullableString(value: unknown): value is string | null {
  return value === null || typeof value === "string";
}

function isNsfwScores(value: unknown): value is GenerationListItem["nsfwScores"] {
  return (
    value === null ||
    (Array.isArray(value) &&
      value.every(
        (score) =>
          !!score &&
          typeof score === "object" &&
          ["porn", "hentai", "sexy"].every(
            (key) => typeof (score as Record<string, unknown>)[key] === "number",
          ),
      ))
  );
}

function isGenerationListItem(item: unknown): item is GenerationListItem {
  if (!item || typeof item !== "object") return false;
  const value = item as Partial<GenerationListItem>;
  return (
    (value.source === "unified" || value.source === "legacy") &&
    typeof value.legacy === "boolean" &&
    (typeof value.id === "string" || typeof value.id === "number") &&
    typeof value.provider === "string" &&
    typeof value.state === "string" &&
    ["active", "succeeded", "failed", "cancelled", "attention"].includes(
      String(value.statusGroup),
    ) &&
    typeof value.prompt === "string" &&
    isNullableString(value.presetKey) &&
    Array.isArray(value.localFiles) &&
    value.localFiles.every((file) => typeof file === "string") &&
    isNullableString(value.filesPurgedAt) &&
    isNullableString(value.errorMessage) &&
    isDateString(value.createdAt) &&
    isNullableString(value.completedAt) &&
    (value.requestSnapshot === null ||
      (!!value.requestSnapshot && typeof value.requestSnapshot === "object")) &&
    isNsfwScores(value.nsfwScores)
  );
}

function isGenerationListResponse(body: unknown): body is GenerationListResponse {
  if (!body || typeof body !== "object") return false;
  const value = body as Partial<GenerationListResponse>;
  return (
    value.ok === true &&
    Array.isArray(value.data) &&
    value.data.every(isGenerationListItem) &&
    typeof value.total === "number" &&
    Number.isFinite(value.total) &&
    typeof value.page === "number" &&
    typeof value.pageSize === "number"
  );
}

export function BotGenerationsPage() {
  const { botId } = useParams<{ botId: string }>();
  return botId ? <BotGenerationsContent key={botId} botId={botId} /> : null;
}

type DeleteNotice = {
  kind: GenerationNoticeKind;
  target: GenerationTarget;
};

function BotGenerationsContent({ botId }: { botId: string }) {
  const { t, i18n } = useTranslation("botData");
  const [page, setPage] = useState(1);
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState("");
  const [source, setSource] = useState("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [deleteBusyKey, setDeleteBusyKey] = useState<string | null>(null);
  const [recovering, setRecovering] = useState(false);
  const [deleteNotice, setDeleteNotice] = useState<DeleteNotice | null>(null);
  const mutationRef = useRef(false);
  const mountedRef = useRef(false);
  const recoveryTargetRef = useRef<GenerationTarget | null>(null);
  const recoveryControllerRef = useRef<AbortController | null>(null);
  const pendingPageFocusRef = useRef(false);
  const focusAfterNoticeRef = useRef(false);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const deleteNoticeRef = useRef<HTMLDivElement>(null);
  const locale = i18n.resolvedLanguage ?? i18n.language;
  const numberFormatter = useMemo(() => new Intl.NumberFormat(locale), [locale]);
  const dateFormatter = useMemo(
    () => new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short" }),
    [locale],
  );

  const requestList = useCallback(
    async (signal: AbortSignal) => {
      const params = new URLSearchParams({ page: String(page), pageSize: String(PAGE_SIZE) });
      if (query.trim()) params.set("q", query.trim());
      if (status) params.set("status", status);
      if (source) params.set("source", source);
      if (from) params.set("from", from);
      if (to) params.set("to", to);
      const response = await authFetch(
        `/api/bots/${encodeURIComponent(botId)}/generations?${params}`,
        { signal },
      );
      return requireGenerationRead<GenerationListResponse>(response, {
        validate: isGenerationListResponse,
      });
    },
    [botId, from, page, query, source, status, to],
  );
  const listKey = JSON.stringify([botId, page, PAGE_SIZE, query.trim(), status, source, from, to]);
  const list = useGenerationResource(listKey, requestList);
  const items = list.result?.data ?? [];
  const total = list.result?.total ?? 0;
  const operationBusy = deleteBusyKey !== null || recovering;
  const writesLocked =
    operationBusy ||
    deleteNotice?.kind === "unknown" ||
    deleteNotice?.kind === "deleted-refresh-failed" ||
    deleteNotice?.kind === "active" ||
    deleteNotice?.kind === "bot-missing";
  const hiddenTarget =
    deleteNotice?.kind === "deleted" ||
    deleteNotice?.kind === "deleted-refresh-failed" ||
    deleteNotice?.kind === "missing"
      ? deleteNotice.target
      : null;
  const displayedItems = hiddenTarget
    ? items.filter(
        (item) => item.source !== hiddenTarget.source || String(item.id) !== hiddenTarget.id,
      )
    : items;

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      recoveryControllerRef.current?.abort();
    };
  }, []);

  useEffect(() => {
    if (!list.result || list.loading || list.failure) return;
    const lastPage = Math.max(1, Math.ceil(total / PAGE_SIZE));
    if (page > lastPage) {
      pendingPageFocusRef.current = true;
      setPage(lastPage);
      return;
    }
    if (pendingPageFocusRef.current) {
      pendingPageFocusRef.current = false;
      requestAnimationFrame(() => {
        headingRef.current?.scrollIntoView({ block: "start" });
        headingRef.current?.focus();
      });
    }
  }, [list.failure, list.loading, list.result, page, total]);

  useEffect(() => {
    if (focusAfterNoticeRef.current) {
      focusAfterNoticeRef.current = false;
      requestAnimationFrame(() => {
        headingRef.current?.scrollIntoView({ block: "start" });
        headingRef.current?.focus();
      });
      return;
    }
    if (!deleteNotice) return;
    requestAnimationFrame(() => {
      deleteNoticeRef.current?.scrollIntoView({ block: "nearest" });
      deleteNoticeRef.current?.focus();
    });
  }, [deleteNotice]);

  const resetFilters = () => {
    if (operationBusy) return;
    setQuery("");
    setStatus("");
    setSource("");
    setFrom("");
    setTo("");
    setPage(1);
  };

  const recoverDeletion = async () => {
    const target = recoveryTargetRef.current;
    if (!target || mutationRef.current) return;
    mutationRef.current = true;
    setRecovering(true);
    const controller = new AbortController();
    recoveryControllerRef.current?.abort();
    recoveryControllerRef.current = controller;
    try {
      if (deleteNotice?.kind === "deleted-refresh-failed") {
        pendingPageFocusRef.current = true;
        const refreshed = await list.refresh();
        if (!mountedRef.current || controller.signal.aborted) return;
        if (refreshed) {
          recoveryTargetRef.current = null;
          focusAfterNoticeRef.current = true;
          setDeleteNotice({ kind: "deleted", target });
        }
        return;
      }
      const [targetState, refreshed] = await Promise.all([
        verifyGenerationTarget(target, controller.signal),
        list.refresh(),
      ]);
      if (!mountedRef.current || controller.signal.aborted) return;
      if (targetState === "bot-missing") {
        setDeleteNotice({ kind: "bot-missing", target });
      } else if (targetState === "present" && refreshed) {
        recoveryTargetRef.current = null;
        focusAfterNoticeRef.current = true;
        setDeleteNotice(null);
      } else if (targetState === "missing" && refreshed) {
        recoveryTargetRef.current = null;
        focusAfterNoticeRef.current = true;
        setDeleteNotice({ kind: "missing", target });
      } else {
        requestAnimationFrame(() => {
          deleteNoticeRef.current?.scrollIntoView({ block: "nearest" });
          deleteNoticeRef.current?.focus();
        });
      }
    } finally {
      mutationRef.current = false;
      if (mountedRef.current) setRecovering(false);
    }
  };

  const remove = async (item: GenerationListItem) => {
    if (mutationRef.current || writesLocked || !window.confirm(t("generations.deleteConfirm")))
      return;
    const target: GenerationTarget = { botId, source: item.source, id: String(item.id) };
    const targetKey = `${target.source}:${target.id}`;
    mutationRef.current = true;
    recoveryTargetRef.current = target;
    setDeleteBusyKey(targetKey);
    setDeleteNotice(null);
    try {
      const result = await deleteGeneration(target);
      if (!mountedRef.current) return;
      if (result === "active") {
        setDeleteNotice({ kind: "active", target });
        return;
      }
      if (result !== "deleted") {
        setDeleteNotice({ kind: "unknown", target });
        return;
      }
      setDeleteNotice({ kind: "deleted", target });
      const refreshed = await list.refresh();
      if (!mountedRef.current) return;
      if (refreshed) {
        recoveryTargetRef.current = null;
        setDeleteNotice({ kind: "deleted", target });
      } else {
        setDeleteNotice({ kind: "deleted-refresh-failed", target });
      }
    } finally {
      mutationRef.current = false;
      if (mountedRef.current) setDeleteBusyKey(null);
    }
  };

  return (
    <div className="space-y-6">
      <header className="relative overflow-hidden rounded-2xl border bg-gradient-to-br from-slate-950 via-slate-900 to-indigo-950 p-6 text-white shadow-sm sm:p-8">
        <div className="pointer-events-none absolute -top-20 -right-12 size-64 rounded-full bg-cyan-400/10 blur-3xl" />
        <div className="relative flex flex-wrap items-end justify-between gap-4">
          <div className="space-y-2">
            <div className="flex items-center gap-2 text-cyan-200">
              <Archive className="size-4" />
              <span className="text-xs font-semibold tracking-[0.18em] uppercase">
                {t("generations.archiveEyebrow")}
              </span>
            </div>
            <h1
              ref={headingRef}
              tabIndex={-1}
              className="text-2xl font-semibold tracking-tight outline-none sm:text-3xl"
            >
              {t("generations.title")}
            </h1>
            <p className="max-w-2xl text-sm leading-6 text-slate-300">
              {t("generations.archiveDescription")}
            </p>
          </div>
          <div className="rounded-xl border border-white/10 bg-white/5 px-4 py-3 backdrop-blur">
            <div className="text-2xl font-semibold tabular-nums">
              {list.result ? numberFormatter.format(total) : "—"}
            </div>
            <div className="text-xs text-slate-400">{t("generations.archivedTasks")}</div>
          </div>
        </div>
      </header>

      <Card>
        <CardContent className="grid gap-3 pt-5 sm:grid-cols-2 sm:pt-6 lg:grid-cols-6">
          <label className="relative sm:col-span-2">
            <Search className="text-muted-foreground pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2" />
            <Input
              value={query}
              maxLength={200}
              disabled={operationBusy}
              onChange={(event) => {
                if (operationBusy) return;
                setQuery(event.target.value);
                setPage(1);
              }}
              className="pl-9"
              placeholder={t("generations.searchPlaceholder")}
              aria-label={t("generations.searchPlaceholder")}
            />
          </label>
          <Select
            value={status}
            disabled={operationBusy}
            onChange={(event) => {
              if (operationBusy) return;
              setStatus(event.target.value);
              setPage(1);
            }}
            aria-label={t("generations.allStatuses")}
          >
            <option value="">{t("generations.allStatuses")}</option>
            <option value="active">{t("generations.active")}</option>
            <option value="succeeded">{t("generations.succeeded")}</option>
            <option value="failed">{t("generations.failed")}</option>
            <option value="cancelled">{t("generations.cancelled")}</option>
            <option value="attention">{t("generations.attention")}</option>
          </Select>
          <Select
            value={source}
            disabled={operationBusy}
            onChange={(event) => {
              if (operationBusy) return;
              setSource(event.target.value);
              setPage(1);
            }}
            aria-label={t("generations.allSources")}
          >
            <option value="">{t("generations.allSources")}</option>
            <option value="unified">{t("generations.unifiedSource")}</option>
            <option value="legacy">{t("generations.legacySource")}</option>
          </Select>
          <label className="relative">
            <CalendarDays className="text-muted-foreground pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2" />
            <Input
              type="date"
              value={from}
              disabled={operationBusy}
              onChange={(event) => {
                if (operationBusy) return;
                setFrom(event.target.value);
                setPage(1);
              }}
              className="pl-9"
              aria-label={t("generations.fromDate")}
            />
          </label>
          <Input
            type="date"
            value={to}
            disabled={operationBusy}
            onChange={(event) => {
              if (operationBusy) return;
              setTo(event.target.value);
              setPage(1);
            }}
            aria-label={t("generations.toDate")}
          />
          {(query || status || source || from || to) && (
            <Button
              variant="ghost"
              size="sm"
              className="lg:col-start-6"
              disabled={operationBusy}
              onClick={resetFilters}
            >
              {t("common.clearFilters")}
            </Button>
          )}
        </CardContent>
      </Card>

      {deleteNotice ? (
        <div ref={deleteNoticeRef} tabIndex={-1} className="outline-none">
          <GenerationDeleteNotice
            kind={deleteNotice.kind}
            busy={recovering}
            onRecover={() => void recoverDeletion()}
          />
        </div>
      ) : null}

      {list.failure === "failed" && deleteNotice?.kind !== "deleted-refresh-failed" ? (
        <div
          className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800"
          role="alert"
        >
          <span className="flex items-center gap-2">
            <AlertTriangle className="size-4 shrink-0" aria-hidden="true" />
            {t(list.result ? "common.refreshFailed" : "common.loadFailed")}
          </span>
          <Button
            variant="outline"
            size="sm"
            disabled={operationBusy || list.loading}
            onClick={() => {
              if (recoveryTargetRef.current) {
                void recoverDeletion();
              } else {
                pendingPageFocusRef.current = true;
                void list.refresh();
              }
            }}
          >
            <RefreshCw className="size-4" aria-hidden="true" />
            {t("common.retry")}
          </Button>
        </div>
      ) : null}

      {list.loading && list.result ? (
        <p className="text-muted-foreground flex items-center gap-2 text-sm" role="status">
          <Loader2 className="size-4 animate-spin" aria-hidden="true" />
          {t("generations.refreshing")}
        </p>
      ) : null}

      {!list.result ? (
        list.loading ? (
          <div className="text-muted-foreground flex items-center justify-center gap-2 py-16 text-sm">
            <Loader2 className="size-4 animate-spin" />
            {t("common.loading")}
          </div>
        ) : null
      ) : items.length === 0 && total === 0 && !list.failure ? (
        <div className="text-muted-foreground flex flex-col items-center gap-3 rounded-2xl border border-dashed py-16 text-sm">
          <ImageOff className="size-8" />
          {t("generations.empty")}
        </div>
      ) : (
        <div className="grid gap-5 sm:grid-cols-2 xl:grid-cols-3">
          {displayedItems.map((item) => {
            const snapshot = item.requestSnapshot;
            const images = item.localFiles.map((file) => generationFileUrl(botId!, file));
            const terminal = isGenerationDeletable(item);
            return (
              <Card key={`${item.source}:${item.id}`} className="group overflow-hidden">
                {images.length > 0 ? (
                  <GenerationGallery
                    images={images}
                    scores={item.nsfwScores}
                    aspectRatio={
                      snapshot?.width && snapshot.height
                        ? `${snapshot.width} / ${snapshot.height}`
                        : undefined
                    }
                  />
                ) : (
                  <div className="bg-muted text-muted-foreground flex aspect-video flex-col items-center justify-center gap-2">
                    {item.statusGroup === "active" ? (
                      <Loader2 className="size-6 animate-spin" />
                    ) : (
                      <ImageOff className="size-6" />
                    )}
                    <span className="text-xs">
                      {item.filesPurgedAt
                        ? t("generations.originalPurged")
                        : t("generations.noImage")}
                    </span>
                  </div>
                )}
                <CardContent className="space-y-4 pt-5 sm:pt-6">
                  <div className="flex flex-wrap items-center gap-2">
                    <GenerationStatusBadge status={item.statusGroup} />
                    <Badge variant="muted">
                      {item.legacy ? t("generations.legacyBadge") : t("generations.unifiedBadge")}
                    </Badge>
                    {hasNsfwFlag(item.nsfwScores) && (
                      <Badge variant="destructive">{t("generations.nsfw")}</Badge>
                    )}
                    <span className="text-muted-foreground ml-auto text-xs tabular-nums">
                      {dateFormatter.format(new Date(item.createdAt))}
                    </span>
                  </div>

                  <div className="space-y-2">
                    <p className="line-clamp-3 text-sm leading-6">{item.prompt}</p>
                    <div className="text-muted-foreground flex flex-wrap gap-x-3 gap-y-1 font-mono text-[11px]">
                      {snapshot?.width && snapshot.height && (
                        <span>
                          {snapshot.width}×{snapshot.height}
                        </span>
                      )}
                      {snapshot?.batchSize && <span>×{snapshot.batchSize}</span>}
                      {item.presetKey && <span>{item.presetKey}</span>}
                      <span>{item.provider}</span>
                    </div>
                  </div>

                  {item.errorMessage && (
                    <p className="rounded-lg bg-red-50 px-3 py-2 text-xs leading-5 text-red-700">
                      {item.errorMessage}
                    </p>
                  )}

                  <div className="flex items-center gap-2 border-t pt-4">
                    <Link
                      className="bg-primary text-primary-foreground focus-visible:ring-ring flex h-10 flex-1 items-center justify-center gap-2 rounded-lg px-3.5 text-sm font-semibold transition-colors hover:bg-blue-700 focus-visible:ring-2 focus-visible:outline-none"
                      to={`/bots/${encodeURIComponent(botId!)}/generations/${item.source}/${encodeURIComponent(item.id)}`}
                      aria-disabled={operationBusy}
                      tabIndex={operationBusy ? -1 : undefined}
                      onClick={(event) => {
                        if (operationBusy) event.preventDefault();
                      }}
                    >
                      <Sparkles className="size-4" />
                      {t("generations.viewDetails")}
                    </Link>
                    {terminal && (
                      <Button
                        variant="ghost"
                        size="icon"
                        disabled={writesLocked || list.loading || !!list.failure}
                        onClick={() => remove(item)}
                        aria-label={t("generations.deleteTitle")}
                      >
                        {deleteBusyKey === `${item.source}:${item.id}` ? (
                          <Loader2 className="size-4 animate-spin" />
                        ) : (
                          <Trash2 className="size-4" />
                        )}
                      </Button>
                    )}
                  </div>
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}

      <Pagination
        page={page}
        totalPages={Math.max(1, Math.ceil(total / PAGE_SIZE))}
        disabled={operationBusy || list.loading || !list.result}
        onPageChange={(nextPage) => {
          if (operationBusy || list.loading) return;
          pendingPageFocusRef.current = true;
          setPage(nextPage);
        }}
      />
    </div>
  );
}

function GenerationStatusBadge({ status }: { status: GenerationListItem["statusGroup"] }) {
  const { t } = useTranslation("botData");
  const variant =
    status === "succeeded"
      ? "success"
      : status === "failed"
        ? "destructive"
        : status === "active" || status === "attention"
          ? "warning"
          : "muted";
  return <Badge variant={variant}>{t(`generations.${status}` as "generations.succeeded")}</Badge>;
}
