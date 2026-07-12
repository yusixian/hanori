import { AuthImage } from "@/components/ui/auth-image";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { Pagination } from "@/components/ui/pagination";
import { Select } from "@/components/ui/select";
import { InlineDisclosure } from "@/components/ui/inline-disclosure";
import { CodeBlock } from "@/components/ui/code-block";
import { authFetch, client } from "@/lib/client";
import { formatDuration } from "@/lib/format";
import { DEFAULT_NSFW_THRESHOLD } from "@cos-tool-bot/shared";
import type { NsfwScores } from "@cos-tool-bot/shared";
import type { InferResponseType } from "hono/client";
import { cn } from "@/lib/utils";
import {
  ChevronDown,
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
import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
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
  const openedBlobUrls = useRef<string[]>([]);

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
          >
            <ChevronLeft className="h-5 w-5" />
          </button>
        )}

        <div className="relative overflow-hidden rounded-lg">
          <AuthImage
            src={currentImage}
            alt="Full size"
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
                NSFW — Click to reveal
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
          >
            <ChevronRight className="h-5 w-5" />
          </button>
        )}
      </div>

      {/* Bottom toolbar */}
      <div className="relative z-10 mt-4 flex items-center gap-4">
        {images.length > 1 && (
          <span className="text-sm text-white/70">
            {index + 1} / {images.length}
          </span>
        )}
        <button
          type="button"
          className="flex items-center gap-1.5 rounded-full bg-white/15 px-4 py-2 text-sm text-white backdrop-blur-sm transition-colors hover:bg-white/25"
          onClick={openOriginal}
        >
          <ExternalLink className="h-4 w-4" />
          Open Original
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
  return (
    <div className="mt-1 space-y-1">
      {scores.map((s, i) => (
        <div key={i} className="flex flex-wrap gap-x-3 gap-y-0.5 text-[11px]">
          {scores.length > 1 && <span className="text-muted-foreground font-medium">#{i + 1}</span>}
          <span>
            porn:{" "}
            <strong className={s.porn >= 0.3 ? "text-red-500" : ""}>{s.porn.toFixed(2)}</strong>
          </span>
          <span>
            sexy:{" "}
            <strong className={s.sexy >= 0.3 ? "text-orange-500" : ""}>{s.sexy.toFixed(2)}</strong>
          </span>
          <span>
            hentai:{" "}
            <strong className={s.hentai >= 0.3 ? "text-red-500" : ""}>{s.hentai.toFixed(2)}</strong>
          </span>
          <span>
            neutral: <strong>{s.neutral.toFixed(2)}</strong>
          </span>
          <span>
            drawing: <strong>{s.drawing.toFixed(2)}</strong>
          </span>
        </div>
      ))}
    </div>
  );
}

function PixaiConfigDetails({ config }: { config: Record<string, unknown> }) {
  return (
    <InlineDisclosure title="Image Config" className="mt-1 border-t pt-1" contentClassName="pt-1">
      <CodeBlock className="max-h-48 text-[11px] leading-relaxed">
        {JSON.stringify(config, null, 2)}
      </CodeBlock>
    </InlineDisclosure>
  );
}

export function BotGenerationsPage() {
  const { botId } = useParams<{ botId: string }>();
  const [generations, setGenerations] = useState<GenerationItem[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true);
  const [filterStatus, setFilterStatus] = useState("");
  const [lightbox, setLightbox] = useState<LightboxState | null>(null);
  const [revealedIds, setRevealedIds] = useState<Set<number>>(new Set());
  const pageSize = 20;

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
    if (!botId || !window.confirm("确定要删除此生成记录及其文件吗？")) return;
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
        <h1 className="text-2xl font-bold">Generations</h1>
        <span className="text-muted-foreground text-sm">{total} total</span>
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
          <option value="">All Status</option>
          <option value="pending">Pending</option>
          <option value="completed">Completed</option>
          <option value="failed">Failed</option>
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
            Clear Filters
          </button>
        )}
      </div>

      {loading ? (
        <div className="flex items-center gap-2 py-8">
          <Loader2 className="h-4 w-4 animate-spin" />
          <span className="text-muted-foreground text-sm">Loading...</span>
        </div>
      ) : generations.length === 0 ? (
        <div className="text-muted-foreground py-8 text-center text-sm">No generations found.</div>
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
                                alt="Generated"
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
                                  NSFW — Click to reveal
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
                      <span className="text-xs">Generating...</span>
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
                      {g.status}
                    </Badge>
                    {g.nsfwScores && Array.isArray(g.nsfwScores) && hasNsfwFlag(g.nsfwScores) && (
                      <Badge variant="destructive" className="gap-0.5 text-[10px]">
                        <ShieldAlert className="h-3 w-3" />
                        NSFW
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
                      {g.width}x{g.height}
                    </span>
                    {g.durationMs != null && (
                      <span className="text-muted-foreground flex items-center gap-1 text-xs">
                        <Clock className="h-3 w-3" />
                        {formatDuration(g.durationMs)}
                      </span>
                    )}
                    <span className="text-muted-foreground ml-auto shrink-0 text-xs">
                      {new Date(g.createdAt).toLocaleString()}
                    </span>
                    <button
                      type="button"
                      className="text-muted-foreground hover:text-destructive shrink-0 p-0.5 transition-colors"
                      onClick={() => handleDelete(g.id)}
                      title="Delete generation"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  </div>

                  {/* Error message */}
                  {g.status === "failed" && g.errorMessage && (
                    <p className="text-destructive text-xs">Error: {g.errorMessage}</p>
                  )}

                  {/* Prompt (collapsible) */}
                  <InlineDisclosure title="Prompt">
                    <div className="mt-1.5 space-y-1.5 pl-4">
                      <div className="text-sm break-words whitespace-pre-wrap">{g.prompt}</div>
                      {g.negativePrompt && (
                        <div className="text-muted-foreground text-xs break-words whitespace-pre-wrap">
                          <span className="font-medium">Negative:</span> {g.negativePrompt}
                        </div>
                      )}
                    </div>
                  </InlineDisclosure>

                  {/* Meta info (collapsible) */}
                  <InlineDisclosure title="Details" className="border-t pt-1">
                    <div className="text-muted-foreground mt-1.5 space-y-0.5 pl-4 text-xs">
                      <div>
                        <span className="font-medium">Model:</span> {g.modelId}
                      </div>
                      <div>
                        <span className="font-medium">Task:</span> {g.taskId}
                      </div>
                      <div>
                        <span className="font-medium">Chat:</span> {g.chatId}
                      </div>
                      {g.samplingSteps != null && (
                        <div>
                          <span className="font-medium">Steps:</span> {g.samplingSteps}
                        </div>
                      )}
                      {g.cfgScale != null && (
                        <div>
                          <span className="font-medium">CFG Scale:</span> {g.cfgScale}
                        </div>
                      )}
                      {g.promptHelper != null && (
                        <div>
                          <span className="font-medium">Prompt Helper:</span>{" "}
                          {g.promptHelper ? "On" : "Off"}
                        </div>
                      )}
                      {g.userId && (
                        <div>
                          <span className="font-medium">User:</span> {g.userId}
                        </div>
                      )}
                      {g.completedAt && (
                        <div>
                          <span className="font-medium">Completed:</span>{" "}
                          {new Date(g.completedAt).toLocaleString()}
                        </div>
                      )}
                      {g.nsfwScores && Array.isArray(g.nsfwScores) && g.nsfwScores.length > 0 && (
                        <div className="border-t pt-1">
                          <span className="text-[10px] font-semibold tracking-wider uppercase">
                            NSFW Scores
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
