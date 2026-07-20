import { authFetch } from "@/lib/client";
import { Loader2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

interface AuthImageProps extends Omit<React.ImgHTMLAttributes<HTMLImageElement>, "src"> {
  src: string;
  fallback?: React.ReactNode;
  errorFallback?: React.ReactNode;
  /** Default width/height for loading/error states when no className sizing is provided */
  placeholderSize?: number;
}

export function AuthImage({
  src,
  fallback,
  errorFallback,
  alt,
  onError,
  placeholderSize = 96,
  ...props
}: AuthImageProps) {
  const { t } = useTranslation("common");
  const [blobUrl, setBlobUrl] = useState<string | null>(null);
  const [error, setError] = useState(false);
  const blobUrlRef = useRef<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    // Revoke previous blob URL
    if (blobUrlRef.current) {
      URL.revokeObjectURL(blobUrlRef.current);
      blobUrlRef.current = null;
    }
    setBlobUrl(null);
    setError(false);

    authFetch(src)
      .then((res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return res.blob();
      })
      .then((blob) => {
        const url = URL.createObjectURL(blob);
        if (cancelled) {
          URL.revokeObjectURL(url);
          return;
        }
        blobUrlRef.current = url;
        setBlobUrl(url);
      })
      .catch(() => {
        if (!cancelled) setError(true);
      });

    return () => {
      cancelled = true;
    };
  }, [src]);

  // Revoke blob URL on unmount
  useEffect(() => {
    return () => {
      if (blobUrlRef.current) URL.revokeObjectURL(blobUrlRef.current);
    };
  }, []);

  if (error) {
    return (
      errorFallback ?? (
        <div
          className="bg-muted text-muted-foreground flex items-center justify-center text-xs"
          style={{ width: placeholderSize, height: placeholderSize }}
        >
          {t("errors.imageFailed")}
        </div>
      )
    );
  }

  if (!blobUrl) {
    return (
      fallback ?? (
        <div
          className="bg-muted flex items-center justify-center"
          style={{ width: placeholderSize, height: placeholderSize }}
        >
          <Loader2 className="text-muted-foreground h-4 w-4 animate-spin" />
        </div>
      )
    );
  }

  return (
    <img
      src={blobUrl}
      alt={alt}
      onError={(event) => {
        if (blobUrlRef.current) {
          URL.revokeObjectURL(blobUrlRef.current);
          blobUrlRef.current = null;
        }
        setBlobUrl(null);
        setError(true);
        onError?.(event);
      }}
      {...props}
    />
  );
}
