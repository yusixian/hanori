import { AuthImage } from "@/components/ui/auth-image";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { Pagination } from "@/components/ui/pagination";
import { Select } from "@/components/ui/select";
import { InlineDisclosure } from "@/components/ui/inline-disclosure";
import { CodeBlock } from "@/components/ui/code-block";
import { authFetch, client } from "@/lib/client";
import { DEFAULT_NSFW_THRESHOLD } from "@cos-tool-bot/shared";
import type { NsfwScores } from "@cos-tool-bot/shared";
import type { InferResponseType } from "hono/client";
import { cn } from "@/lib/utils";
import {
  ChevronLeft,
  ChevronRight,
  Clock,
  ExternalLink,
  EyeOff,
  Loader2,
  ShieldAlert,
  Trash2,
  X,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import { useParams } from "react-router";

type GenerationsResponse = InferResponseType<
  (typeof client.api.bots)[":botId"]["generations"]["$get"],
  200
>;
type GenerationItem = GenerationsResponse["data"][number];

interface LightboxState {
  images: string[];
  index: number;
  nsfw?: boolean;
  generationId?: number;
}

const statusColors: Record<string, string> = {
  pending: "warning",
  completed: "success",
  failed: "destructive",
};

function ImageLightbox({
  images,
  index,
  onClose,
  onNavigate,
  nsfw,
  onReveal,
}: {
  images: string[];
  index: number;
  onClose: () => void;
  onNavigate: (index: number) => void;
  nsfw?: boolean;
  onReveal?: () => void;
}) {
  const { t, i18n } = useTranslation("botData");
  const openedBlobUrls = useRef<string[]>([]);
  const locale = i18n.resolvedLanguage ?? i18n.language;
  const numberFormatter = useMemo(() => new Intl.NumberFormat(locale), [locale]);

  useEffect(() => {
    return () => {
      for (const url of openedBlobUrls.current) URL.revokeObjectURL(url);
    };
  }, []);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
      if (e.key === "ArrowLeft" && index > 0) onNavigate(index - 1);
      if (e.key === "ArrowRight" && index < images.length - 1) onNavigate(index + 1);
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [onClose, onNavigate, index, images.length]);

  const currentImage = images[index];

  const openOriginal = async () => {
    if (!currentImage) return;
    try {
      const res = await authFetch(currentImage);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const blob = await res.blob();
      const blobUrl = URL.createObjectURL(blob);
      openedBlobUrls.current.push(blobUrl);
      window.open(blobUrl, "_blank");
    } catch (err) {
      console.error("Failed to open image:", err);
    }
  };

  if (!currentImage) return null;

  return createPortal(
    <div className="fixed inset-0 z-50 flex flex-col items-center justify-center">
      {/* Backdrop */}
      <div className="absolute inset-0 bg-black/80" onClick={onClose} />

      {/* Close button */}
      <button
        type="button"
        className="absolute top-4 right-4 z-10 rounded-full bg-black/50 p-2 text-white transition-colors hover:bg-black/70"
        onClick={onClose}
        aria-label={t("generations.closePreview")}
      >
        <X className="h-5 w-5" />
      </button>

      {/* Image */}
      <div className="relative flex max-h-[85vh] max-w-[90vw] items-center justify-center">
        {/* Left arrow */}
        {images.length > 1 && index > 0 && (
          <button
            type="button"
            className="absolute -left-12 z-10 rounded-full bg-black/50 p-2 text-white transition-colors hover:bg-black/70"
            onClick={() => onNavigate(index - 1)}
            aria-label={t("generations.previousImage")}
          >
            <ChevronLeft className="h-5 w-5" />
          </button>
        )}

        <div className="relative overflow-hidden rounded-lg">
          <AuthImage
            src={currentImage}
            alt={t("generations.fullSizeAlt")}
            className={cn(
              "max-h-[85vh] max-w-[90vw] object-contain transition-[filter] duration-300",
              nsfw && "scale-105 blur-3xl",
            )}
            fallback={
              <div className="flex h-64 w-64 items-center justify-center rounded-lg bg-zinc-800">
                <Loader2 className="h-8 w-8 animate-spin text-white" />
              </div>
            }
          />
          {nsfw && (
            <button
              type="button"
              className="absolute inset-0 flex cursor-pointer flex-col items-center justify-center gap-3 bg-black/20 transition-colors hover:bg-black/30"
              onClick={onReveal}
            >
              <EyeOff className="h-10 w-10 text-white drop-shadow" />
              <span className="text-sm font-medium text-white drop-shadow">
                {t("generations.nsfwReveal")}
              </span>
            </button>
          )}
        </div>

        {/* Right arrow */}
        {images.length > 1 && index < images.length - 1 && (
          <button
            type="button"
            className="absolute -right-12 z-10 rounded-full bg-black/50 p-2 text-white transition-colors hover:bg-black/70"
            onClick={() => onNavigate(index + 1)}
            aria-label={t("generations.nextImage")}
          >
            <ChevronRight className="h-5 w-5" />
          </button>
        )}
      </div>

      {/* Bottom toolbar */}
      <div className="relative z-10 mt-4 flex items-center gap-4">
        {images.length > 1 && (
          <span className="text-sm text-white/70">
            {t("generations.imagePosition", {
              current: numberFormatter.format(index + 1),
              total: numberFormatter.format(images.length),
            })}
          </span>
        )}
        <button
          type="button"
          className="flex items-center gap-1.5 rounded-full bg-white/15 px-4 py-2 text-sm text-white backdrop-blur-sm transition-colors hover:bg-white/25"
          onClick={openOriginal}
        >
          <ExternalLink className="h-4 w-4" />
          {t("generations.openOriginal")}
        </button>
      </div>
    </div>,
    document.body,
  );
}

function getStyleKeyId(pixaiConfig: unknown): string | undefined {
  if (!pixaiConfig || typeof pixaiConfig !== "object") return undefined;
  const ms = (pixaiConfig as Record<string, unknown>).modelStyle;
  if (!ms || typeof ms !== "object") return undefined;
  return (ms as { keyId?: string }).keyId;
}

function hasNsfwFlag(scores: NsfwScores[]): boolean {
  return scores.some((s) => s.porn + s.hentai + s.sexy >= DEFAULT_NSFW_THRESHOLD);
}

function NsfwScoresDetails({ scores }: { scores: NsfwScores[] }) {
  const { t, i18n } = useTranslation("botData");
  const locale = i18n.resolvedLanguage ?? i18n.language;
  const scoreFormatter = useMemo(
    () => new Intl.NumberFormat(locale, { minimumFractionDigits: 2, maximumFractionDigits: 2 }),
    [locale],
  );

  return (
    <div className="mt-1 space-y-1">
      {scores.map((s, i) => (
        <div key={i} className="flex flex-wrap gap-x-3 gap-y-0.5 text-[11px]">
          {scores.length > 1 && <span className="text-muted-foreground font-medium">#{i + 1}</span>}
          <span>
            {t("generations.pornScore")}:{" "}
            <strong className={s.porn >= 0.3 ? "text-red-500" : ""}>
              {scoreFormatter.format(s.porn)}
            </strong>
          </span>
          <span>
            {t("generations.sexyScore")}:{" "}
            <strong className={s.sexy >= 0.3 ? "text-orange-500" : ""}>
              {scoreFormatter.format(s.sexy)}
            </strong>
          </span>
          <span>
            {t("generations.hentaiScore")}:{" "}
            <strong className={s.hentai >= 0.3 ? "text-red-500" : ""}>
              {scoreFormatter.format(s.hentai)}
            </strong>
          </span>
          <span>
            {t("generations.neutralScore")}: <strong>{scoreFormatter.format(s.neutral)}</strong>
          </span>
          <span>
            {t("generations.drawingScore")}: <strong>{scoreFormatter.format(s.drawing)}</strong>
          </span>
        </div>
      ))}
    </div>
  );
}

function PixaiConfigDetails({ config }: { config: Record<string, unknown> }) {
  const { t } = useTranslation("botData");

  return (
    <InlineDisclosure
      title={t("generations.imageConfig")}
      className="mt-1 border-t pt-1"
      contentClassName="pt-1"
    >
      <CodeBlock className="max-h-48 text-[11px] leading-relaxed">
        {JSON.stringify(config, null, 2)}
      </CodeBlock>
    </InlineDisclosure>
  );
}

export function BotGenerationsPage() {
  const { t, i18n } = useTranslation("botData");
  const { botId } = useParams<{ botId: string }>();
  const [generations, setGenerations] = useState<GenerationItem[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true);
  const [filterStatus, setFilterStatus] = useState("");
  const [lightbox, setLightbox] = useState<LightboxState | null>(null);
  const [revealedIds, setRevealedIds] = useState<Set<number>>(new Set());
  const pageSize = 20;
  const locale = i18n.resolvedLanguage ?? i18n.language;
  const numberFormatter = useMemo(() => new Intl.NumberFormat(locale), [locale]);
  const decimalFormatter = useMemo(
    () => new Intl.NumberFormat(locale, { maximumFractionDigits: 1 }),
    [locale],
  );
  const dateTimeFormatter = useMemo(
    () => new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short" }),
    [locale],
  );
  const statusLabels: Record<string, string> = {
    pending: t("generations.pending"),
    completed: t("generations.completed"),
    failed: t("generations.failed"),
  };
  const formatGenerationDuration = (milliseconds: number) =>
    milliseconds < 1000
      ? t("generations.milliseconds", { value: numberFormatter.format(milliseconds) })
      : t("generations.seconds", { value: decimalFormatter.format(milliseconds / 1000) });

  const loadGenerations = useCallback(async () => {
    if (!botId) return;
    setLoading(true);
    try {
      const query: Record<string, string> = {
        page: String(page),
        pageSize: String(pageSize),
      };
      if (filterStatus) query.status = filterStatus;

      const res = await client.api.bots[":botId"].generations.$get({
        param: { botId },
        query,
      });
      const json = await res.json();
      if (json.ok) {
        setGenerations(json.data);
        setTotal(json.total);
      }
    } catch (err) {
      console.error("Failed to load generations:", err);
    } finally {
      setLoading(false);
    }
  }, [botId, page, filterStatus]);

  useEffect(() => {
    loadGenerations();
  }, [loadGenerations]);

  const totalPages = Math.ceil(total / pageSize);

  const getImageUrl = (botId: string, localFile: string) =>
    `/api/bots/${botId}/files-raw/${localFile}`;

  const isNsfwGeneration = (g: GenerationItem) =>
    g.nsfwScores != null && Array.isArray(g.nsfwScores) && hasNsfwFlag(g.nsfwScores);

  const revealGeneration = (id: number) => setRevealedIds((prev) => new Set(prev).add(id));

  const openLightbox = (g: GenerationItem, imageIndex: number) => {
    if (!g.localFiles) return;
    setLightbox({
      images: g.localFiles.map((f) => getImageUrl(g.botId, f)),
      index: imageIndex,
      nsfw: isNsfwGeneration(g) && !revealedIds.has(g.id),
      generationId: g.id,
    });
  };

  const handleDelete = async (generationId: number) => {
    if (!botId || !window.confirm(t("generations.deleteConfirm"))) return;
    try {
      const res = await client.api.bots[":botId"].generations[":generationId"].$delete({
        param: { botId, generationId: String(generationId) },
      });
      const json = await res.json();
      if (json.ok) {
        setGenerations((prev) => prev.filter((g) => g.id !== generationId));
        setTotal((prev) => prev - 1);
      }
    } catch (err) {
      console.error("Failed to delete generation:", err);
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3">
        <h1 className="text-2xl font-bold">{t("generations.title")}</h1>
        <span className="text-muted-foreground text-sm">
          {t("common.total", { value: numberFormatter.format(total) })}
        </span>
      </div>

      {/* Filters */}
      <div className="flex flex-wrap items-center gap-2">
        <Select
          className="border-input flex h-9 rounded-md border bg-transparent px-3 py-1 text-sm"
          value={filterStatus}
          onChange={(e) => {
            setFilterStatus(e.target.value);
            setPage(1);
          }}
        >
          <option value="">{t("generations.allStatuses")}</option>
          <option value="pending">{t("generations.pending")}</option>
          <option value="completed">{t("generations.completed")}</option>
          <option value="failed">{t("generations.failed")}</option>
        </Select>

        {filterStatus && (
          <button
            type="button"
            className="text-muted-foreground hover:text-foreground text-sm"
            onClick={() => {
              setFilterStatus("");
              setPage(1);
            }}
          >
            {t("common.clearFilters")}
          </button>
        )}
      </div>

      {loading ? (
        <div className="flex items-center gap-2 py-8">
          <Loader2 className="h-4 w-4 animate-spin" />
          <span className="text-muted-foreground text-sm">{t("common.loading")}</span>
        </div>
      ) : generations.length === 0 ? (
        <div className="text-muted-foreground py-8 text-center text-sm">
          {t("generations.empty")}
        </div>
      ) : (
        <div className="columns-1 gap-4 sm:columns-2 lg:columns-3">
          {generations.map((g) => (
            <div key={g.id} className="mb-4 break-inside-avoid">
              <Card className="overflow-hidden">
                {/* Images */}
                {g.status === "completed" &&
                  g.localFiles &&
                  g.localFiles.length > 0 &&
                  (() => {
                    const nsfw = isNsfwGeneration(g);
                    const revealed = revealedIds.has(g.id);
                    const blurred = nsfw && !revealed;
                    return (
                      <div className="space-y-0.5">
                        {g.localFiles.map((file, i) => (
                          <div key={file} className="relative overflow-hidden">
                            <button
                              type="button"
                              className="block w-full cursor-pointer overflow-hidden transition-opacity hover:opacity-90"
                              onClick={() => !blurred && openLightbox(g, i)}
                            >
                              <AuthImage
                                src={getImageUrl(g.botId, file)}
                                alt={t("generations.generatedAlt")}
                                className={cn(
                                  "w-full object-cover transition-[filter] duration-300",
                                  blurred && "scale-105 blur-2xl",
                                )}
                                fallback={
                                  <div
                                    className="bg-muted flex w-full items-center justify-center"
                                    style={{
                                      aspectRatio: `${g.width}/${g.height}`,
                                    }}
                                  >
                                    <Loader2 className="text-muted-foreground h-6 w-6 animate-spin" />
                                  </div>
                                }
                              />
                            </button>
                            {blurred && (
                              <button
                                type="button"
                                className="absolute inset-0 flex cursor-pointer flex-col items-center justify-center gap-2 bg-black/20 transition-colors hover:bg-black/30"
                                onClick={() => revealGeneration(g.id)}
                              >
                                <EyeOff className="h-6 w-6 text-white drop-shadow" />
                                <span className="text-xs font-medium text-white drop-shadow">
                                  {t("generations.nsfwReveal")}
                                </span>
                              </button>
                            )}
                          </div>
                        ))}
                      </div>
                    );
                  })()}

                {/* Pending status */}
                {g.status === "pending" && (
                  <div
                    className="bg-muted flex w-full items-center justify-center"
                    style={{ aspectRatio: `${g.width}/${g.height}` }}
                  >
                    <div className="text-muted-foreground flex flex-col items-center gap-2">
                      <Loader2 className="h-6 w-6 animate-spin" />
                      <span className="text-xs">{t("generations.generating")}</span>
                    </div>
                  </div>
                )}

                <CardContent className="space-y-2 !p-3 !pt-3">
                  {/* Status + Size + Duration + Time */}
                  <div className="flex flex-wrap items-center gap-1.5">
                    <Badge
                      variant={
                        (statusColors[g.status] as "warning" | "success" | "destructive") ??
                        "default"
                      }
                    >
                      {statusLabels[g.status] ?? g.status}
                    </Badge>
                    {g.nsfwScores && Array.isArray(g.nsfwScores) && hasNsfwFlag(g.nsfwScores) && (
                      <Badge variant="destructive" className="gap-0.5 text-[10px]">
                        <ShieldAlert className="h-3 w-3" />
                        {t("generations.nsfw")}
                      </Badge>
                    )}
                    {(() => {
                      const keyId = getStyleKeyId(g.pixaiConfig);
                      return keyId ? (
                        <Badge variant="muted" className="text-[10px]">
                          {keyId}
                        </Badge>
                      ) : null;
                    })()}
                    <span className="text-muted-foreground text-xs">
                      {numberFormatter.format(g.width)}x{numberFormatter.format(g.height)}
                    </span>
                    {g.durationMs != null && (
                      <span className="text-muted-foreground flex items-center gap-1 text-xs">
                        <Clock className="h-3 w-3" />
                        {formatGenerationDuration(g.durationMs)}
                      </span>
                    )}
                    <span className="text-muted-foreground ml-auto shrink-0 text-xs">
                      {dateTimeFormatter.format(new Date(g.createdAt))}
                    </span>
                    <button
                      type="button"
                      className="text-muted-foreground hover:text-destructive shrink-0 p-0.5 transition-colors"
                      onClick={() => handleDelete(g.id)}
                      title={t("generations.deleteTitle")}
                      aria-label={t("generations.deleteTitle")}
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  </div>

                  {/* Error message */}
                  {g.status === "failed" && g.errorMessage && (
                    <p className="text-destructive text-xs">
                      {t("generations.error", { message: g.errorMessage })}
                    </p>
                  )}

                  {/* Prompt (collapsible) */}
                  <InlineDisclosure title={t("generations.prompt")}>
                    <div className="mt-1.5 space-y-1.5 pl-4">
                      <div className="text-sm break-words whitespace-pre-wrap">{g.prompt}</div>
                      {g.negativePrompt && (
                        <div className="text-muted-foreground text-xs break-words whitespace-pre-wrap">
                          <span className="font-medium">{t("generations.negativePrompt")}:</span>{" "}
                          {g.negativePrompt}
                        </div>
                      )}
                    </div>
                  </InlineDisclosure>

                  {/* Meta info (collapsible) */}
                  <InlineDisclosure title={t("generations.details")} className="border-t pt-1">
                    <div className="text-muted-foreground mt-1.5 space-y-0.5 pl-4 text-xs">
                      <div>
                        <span className="font-medium">{t("generations.model")}:</span> {g.modelId}
                      </div>
                      <div>
                        <span className="font-medium">{t("generations.task")}:</span> {g.taskId}
                      </div>
                      <div>
                        <span className="font-medium">{t("generations.chat")}:</span> {g.chatId}
                      </div>
                      {g.samplingSteps != null && (
                        <div>
                          <span className="font-medium">{t("generations.steps")}:</span>{" "}
                          {numberFormatter.format(g.samplingSteps)}
                        </div>
                      )}
                      {g.cfgScale != null && (
                        <div>
                          <span className="font-medium">{t("generations.cfgScale")}:</span>{" "}
                          {decimalFormatter.format(g.cfgScale)}
                        </div>
                      )}
                      {g.promptHelper != null && (
                        <div>
                          <span className="font-medium">{t("generations.promptHelper")}:</span>{" "}
                          {g.promptHelper ? t("common.on") : t("common.off")}
                        </div>
                      )}
                      {g.userId && (
                        <div>
                          <span className="font-medium">{t("generations.user")}:</span> {g.userId}
                        </div>
                      )}
                      {g.completedAt && (
                        <div>
                          <span className="font-medium">{t("generations.completedAt")}:</span>{" "}
                          {dateTimeFormatter.format(new Date(g.completedAt))}
                        </div>
                      )}
                      {g.nsfwScores && Array.isArray(g.nsfwScores) && g.nsfwScores.length > 0 && (
                        <div className="border-t pt-1">
                          <span className="text-[10px] font-semibold tracking-wider uppercase">
                            {t("generations.nsfwScores")}
                          </span>
                          <NsfwScoresDetails scores={g.nsfwScores} />
                        </div>
                      )}
                      {g.pixaiConfig &&
                        typeof g.pixaiConfig === "object" &&
                        !Array.isArray(g.pixaiConfig) && (
                          <PixaiConfigDetails config={g.pixaiConfig as Record<string, unknown>} />
                        )}
                    </div>
                  </InlineDisclosure>
                </CardContent>
              </Card>
            </div>
          ))}
        </div>
      )}

      <Pagination page={page} totalPages={totalPages} onPageChange={setPage} />

      {/* Lightbox */}
      {lightbox && (
        <ImageLightbox
          images={lightbox.images}
          index={lightbox.index}
          onClose={() => setLightbox(null)}
          onNavigate={(i) => setLightbox((prev) => (prev ? { ...prev, index: i } : null))}
          nsfw={lightbox.nsfw}
          onReveal={() => {
            if (lightbox.generationId) revealGeneration(lightbox.generationId);
            setLightbox((prev) => (prev ? { ...prev, nsfw: false } : null));
          }}
        />
      )}
    </div>
  );
}
