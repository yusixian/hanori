import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Pagination } from "@/components/ui/pagination";
import { Select } from "@/components/ui/select";
import { authFetch } from "@/lib/client";
import { Archive, CalendarDays, ImageOff, Loader2, Search, Sparkles, Trash2 } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Link, useParams } from "react-router";
import { GenerationGallery, hasNsfwFlag } from "./generation-gallery";
import {
  generationFileUrl,
  isGenerationDeletable,
  type GenerationListItem,
  type GenerationListResponse,
} from "./generation-types";

const PAGE_SIZE = 20;

export function BotGenerationsPage() {
  const { t, i18n } = useTranslation("botData");
  const { botId } = useParams<{ botId: string }>();
  const [items, setItems] = useState<GenerationListItem[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true);
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState("");
  const [source, setSource] = useState("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const locale = i18n.resolvedLanguage ?? i18n.language;
  const numberFormatter = useMemo(() => new Intl.NumberFormat(locale), [locale]);
  const dateFormatter = useMemo(
    () => new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short" }),
    [locale],
  );

  const load = useCallback(async () => {
    if (!botId) return;
    setLoading(true);
    const params = new URLSearchParams({ page: String(page), pageSize: String(PAGE_SIZE) });
    if (query.trim()) params.set("q", query.trim());
    if (status) params.set("status", status);
    if (source) params.set("source", source);
    if (from) params.set("from", from);
    if (to) params.set("to", to);
    try {
      const response = await authFetch(
        `/api/bots/${encodeURIComponent(botId)}/generations?${params}`,
      );
      if (!response.ok) return;
      const result = (await response.json()) as GenerationListResponse;
      setItems(result.data);
      setTotal(result.total);
    } finally {
      setLoading(false);
    }
  }, [botId, from, page, query, source, status, to]);

  useEffect(() => void load(), [load]);

  const resetFilters = () => {
    setQuery("");
    setStatus("");
    setSource("");
    setFrom("");
    setTo("");
    setPage(1);
  };

  const remove = async (item: GenerationListItem) => {
    if (!botId || !window.confirm(t("generations.deleteConfirm"))) return;
    const response = await authFetch(
      `/api/bots/${encodeURIComponent(botId)}/generations/${item.source}/${encodeURIComponent(item.id)}`,
      { method: "DELETE" },
    );
    if (response.ok) await load();
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
            <h1 className="text-2xl font-semibold tracking-tight sm:text-3xl">
              {t("generations.title")}
            </h1>
            <p className="max-w-2xl text-sm leading-6 text-slate-300">
              {t("generations.archiveDescription")}
            </p>
          </div>
          <div className="rounded-xl border border-white/10 bg-white/5 px-4 py-3 backdrop-blur">
            <div className="text-2xl font-semibold tabular-nums">
              {numberFormatter.format(total)}
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
              onChange={(event) => {
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
            onChange={(event) => {
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
            onChange={(event) => {
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
              onChange={(event) => {
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
            onChange={(event) => {
              setTo(event.target.value);
              setPage(1);
            }}
            aria-label={t("generations.toDate")}
          />
          {(query || status || source || from || to) && (
            <Button variant="ghost" size="sm" className="lg:col-start-6" onClick={resetFilters}>
              {t("common.clearFilters")}
            </Button>
          )}
        </CardContent>
      </Card>

      {loading ? (
        <div className="text-muted-foreground flex items-center justify-center gap-2 py-16 text-sm">
          <Loader2 className="size-4 animate-spin" />
          {t("common.loading")}
        </div>
      ) : items.length === 0 ? (
        <div className="text-muted-foreground flex flex-col items-center gap-3 rounded-2xl border border-dashed py-16 text-sm">
          <ImageOff className="size-8" />
          {t("generations.empty")}
        </div>
      ) : (
        <div className="grid gap-5 sm:grid-cols-2 xl:grid-cols-3">
          {items.map((item) => {
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
                    >
                      <Sparkles className="size-4" />
                      {t("generations.viewDetails")}
                    </Link>
                    {terminal && (
                      <Button
                        variant="ghost"
                        size="icon"
                        onClick={() => remove(item)}
                        aria-label={t("generations.deleteTitle")}
                      >
                        <Trash2 className="size-4" />
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
        onPageChange={setPage}
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
