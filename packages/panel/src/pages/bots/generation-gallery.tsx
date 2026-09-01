import { AuthImage } from "@/components/ui/auth-image";
import { Button } from "@/components/ui/button";
import { authFetch } from "@/lib/client";
import { cn } from "@/lib/utils";
import { DEFAULT_NSFW_THRESHOLD, type NsfwScores } from "@cos-tool-bot/shared";
import { ChevronLeft, ChevronRight, Download, EyeOff, Loader2, X } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";

export function hasNsfwFlag(scores: NsfwScores[] | null): boolean {
  return Boolean(
    scores?.some((score) => score.porn + score.hentai + score.sexy >= DEFAULT_NSFW_THRESHOLD),
  );
}

export function GenerationGallery({
  images,
  scores,
  aspectRatio,
}: {
  images: string[];
  scores: NsfwScores[] | null;
  aspectRatio?: string;
}) {
  const { t } = useTranslation("botData");
  const [revealed, setRevealed] = useState(false);
  const [index, setIndex] = useState<number | null>(null);
  const blurred = hasNsfwFlag(scores) && !revealed;

  if (images.length === 0) return null;

  return (
    <>
      <div className={cn("grid gap-1", images.length > 1 && "grid-cols-2")}>
        {images.map((image, imageIndex) => (
          <div key={image} className="group relative overflow-hidden bg-slate-100">
            <button
              type="button"
              className="block w-full overflow-hidden text-left"
              onClick={() => !blurred && setIndex(imageIndex)}
              aria-label={t("generations.openImage", { index: imageIndex + 1 })}
            >
              <AuthImage
                src={image}
                alt={t("generations.generatedAlt")}
                className={cn(
                  "h-full w-full object-cover transition-[filter,transform] duration-300 group-hover:scale-[1.015]",
                  blurred && "scale-105 blur-2xl",
                )}
                style={{ aspectRatio: aspectRatio ?? "1 / 1" }}
                fallback={
                  <div
                    className="bg-muted flex w-full items-center justify-center"
                    style={{ aspectRatio: aspectRatio ?? "1 / 1" }}
                  >
                    <Loader2 className="text-muted-foreground size-6 animate-spin" />
                  </div>
                }
              />
            </button>
            {blurred && (
              <button
                type="button"
                className="absolute inset-0 flex flex-col items-center justify-center gap-2 bg-slate-950/20 text-white"
                onClick={() => setRevealed(true)}
              >
                <EyeOff className="size-7 drop-shadow" />
                <span className="text-xs font-semibold drop-shadow">
                  {t("generations.nsfwReveal")}
                </span>
              </button>
            )}
          </div>
        ))}
      </div>
      {index !== null && (
        <GenerationLightbox
          images={images}
          index={index}
          onIndexChange={setIndex}
          onClose={() => setIndex(null)}
        />
      )}
    </>
  );
}

function GenerationLightbox({
  images,
  index,
  onIndexChange,
  onClose,
}: {
  images: string[];
  index: number;
  onIndexChange: (index: number) => void;
  onClose: () => void;
}) {
  const { t, i18n } = useTranslation("botData");
  const locale = i18n.resolvedLanguage ?? i18n.language;
  const formatter = useMemo(() => new Intl.NumberFormat(locale), [locale]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
      if (event.key === "ArrowLeft" && index > 0) onIndexChange(index - 1);
      if (event.key === "ArrowRight" && index < images.length - 1) onIndexChange(index + 1);
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [images.length, index, onClose, onIndexChange]);

  const download = async () => {
    const response = await authFetch(images[index]!);
    if (!response.ok) return;
    const url = URL.createObjectURL(await response.blob());
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `generation-${index + 1}`;
    anchor.click();
    URL.revokeObjectURL(url);
  };

  return createPortal(
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/90 p-4">
      <button
        type="button"
        className="absolute inset-0"
        aria-label={t("generations.closePreview")}
        onClick={onClose}
      />
      <div className="relative z-10 flex max-h-full max-w-full flex-col items-center gap-4">
        <AuthImage
          src={images[index]!}
          alt={t("generations.fullSizeAlt")}
          className="max-h-[82vh] max-w-[92vw] rounded-lg object-contain shadow-2xl"
        />
        <div className="flex items-center gap-2 text-white">
          <Button
            variant="ghost"
            size="icon"
            className="text-white hover:bg-white/15 hover:text-white"
            disabled={index === 0}
            onClick={() => onIndexChange(index - 1)}
            aria-label={t("generations.previousImage")}
          >
            <ChevronLeft className="size-5" />
          </Button>
          <span className="min-w-20 text-center text-sm tabular-nums">
            {formatter.format(index + 1)} / {formatter.format(images.length)}
          </span>
          <Button
            variant="ghost"
            size="icon"
            className="text-white hover:bg-white/15 hover:text-white"
            disabled={index === images.length - 1}
            onClick={() => onIndexChange(index + 1)}
            aria-label={t("generations.nextImage")}
          >
            <ChevronRight className="size-5" />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className="text-white hover:bg-white/15 hover:text-white"
            onClick={download}
            aria-label={t("generations.downloadOriginal")}
          >
            <Download className="size-5" />
          </Button>
        </div>
      </div>
      <Button
        variant="ghost"
        size="icon"
        className="absolute top-3 right-3 z-20 text-white hover:bg-white/15 hover:text-white"
        onClick={onClose}
        aria-label={t("generations.closePreview")}
      >
        <X className="size-5" />
      </Button>
    </div>,
    document.body,
  );
}
