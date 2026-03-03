import { AuthImage } from "@/components/ui/auth-image";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { Pagination } from "@/components/ui/pagination";
import { authFetch, client } from "@/lib/client";
import { formatDuration } from "@/lib/format";
import type { InferResponseType } from "hono/client";
import {
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Clock,
  ExternalLink,
  Loader2,
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
}: {
  images: string[];
  index: number;
  onClose: () => void;
  onNavigate: (index: number) => void;
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

        <AuthImage
          src={currentImage}
          alt="Full size"
          className="max-h-[85vh] max-w-[90vw] rounded-lg object-contain"
          fallback={
            <div className="flex h-64 w-64 items-center justify-center rounded-lg bg-zinc-800">
              <Loader2 className="h-8 w-8 animate-spin text-white" />
            </div>
          }
        />

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

function PixaiConfigDetails({ config }: { config: Record<string, unknown> }) {
  return (
    <details className="group/cfg mt-1 border-t pt-1">
      <summary className="flex cursor-pointer list-none items-center gap-1 select-none">
        <ChevronDown className="h-3 w-3 transition-transform group-open/cfg:rotate-180" />
        <span className="text-[10px] font-semibold tracking-wider uppercase">Image Config</span>
      </summary>
      <pre className="bg-muted mt-1 max-h-48 overflow-auto rounded p-2 text-[11px] leading-relaxed">
        {JSON.stringify(config, null, 2)}
      </pre>
    </details>
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

  const openLightbox = (g: GenerationItem, imageIndex: number) => {
    if (!g.localFiles) return;
    setLightbox({
      images: g.localFiles.map((f) => getImageUrl(g.botId, f)),
      index: imageIndex,
    });
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3">
        <h1 className="text-2xl font-bold">Generations</h1>
        <span className="text-muted-foreground text-sm">{total} total</span>
      </div>

      {/* Filters */}
      <div className="flex flex-wrap items-center gap-2">
        <select
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
        </select>

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
                {g.status === "completed" && g.localFiles && g.localFiles.length > 0 && (
                  <div className="space-y-0.5">
                    {g.localFiles.map((file, i) => (
                      <button
                        key={file}
                        type="button"
                        className="block w-full cursor-pointer overflow-hidden transition-opacity hover:opacity-90"
                        onClick={() => openLightbox(g, i)}
                      >
                        <AuthImage
                          src={getImageUrl(g.botId, file)}
                          alt="Generated"
                          className="w-full object-cover"
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
                    ))}
                  </div>
                )}

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
                    {getStyleKeyId(g.pixaiConfig) && (
                      <Badge variant="muted" className="text-[10px]">
                        {getStyleKeyId(g.pixaiConfig)}
                      </Badge>
                    )}
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
                  </div>

                  {/* Error message */}
                  {g.status === "failed" && g.errorMessage && (
                    <p className="text-destructive text-xs">Error: {g.errorMessage}</p>
                  )}

                  {/* Prompt (collapsible) */}
                  <details className="group">
                    <summary className="text-muted-foreground flex cursor-pointer list-none items-center gap-1 text-xs select-none">
                      <ChevronDown className="h-3 w-3 transition-transform group-open:rotate-180" />
                      <span className="font-medium">Prompt</span>
                    </summary>
                    <div className="mt-1.5 space-y-1.5 pl-4">
                      <div className="text-sm break-words whitespace-pre-wrap">{g.prompt}</div>
                      {g.negativePrompt && (
                        <div className="text-muted-foreground text-xs break-words whitespace-pre-wrap">
                          <span className="font-medium">Negative:</span> {g.negativePrompt}
                        </div>
                      )}
                    </div>
                  </details>

                  {/* Meta info (collapsible) */}
                  <details className="group">
                    <summary className="text-muted-foreground flex cursor-pointer list-none items-center gap-1 border-t pt-2 text-xs select-none">
                      <ChevronDown className="h-3 w-3 transition-transform group-open:rotate-180" />
                      <span className="font-medium">Details</span>
                    </summary>
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
                      {g.pixaiConfig &&
                        typeof g.pixaiConfig === "object" &&
                        !Array.isArray(g.pixaiConfig) && (
                          <PixaiConfigDetails config={g.pixaiConfig as Record<string, unknown>} />
                        )}
                    </div>
                  </details>
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
        />
      )}
    </div>
  );
}
