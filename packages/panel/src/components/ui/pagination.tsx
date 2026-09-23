import { Button } from "@/components/ui/button";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";

interface PaginationProps {
  page: number;
  totalPages: number;
  onPageChange: (page: number) => void;
  className?: string;
  disabled?: boolean;
}

export function Pagination({
  page,
  totalPages,
  onPageChange,
  className,
  disabled = false,
}: PaginationProps) {
  const { t } = useTranslation("common");
  const [editValue, setEditValue] = useState<string | null>(null);

  if (totalPages <= 1) return null;

  const handleSubmit = () => {
    if (disabled || editValue === null) return;
    const num = Number.parseInt(editValue, 10);
    if (!Number.isNaN(num)) {
      onPageChange(Math.min(Math.max(1, num), totalPages));
    }
    setEditValue(null);
  };

  return (
    <div className={className ?? "flex items-center justify-center gap-2"}>
      <Button
        variant="outline"
        size="sm"
        disabled={disabled || page <= 1}
        onClick={() => onPageChange(page - 1)}
        aria-label={t("pagination.previous")}
      >
        <ChevronLeft className="h-4 w-4" />
      </Button>
      {editValue !== null ? (
        <input
          type="text"
          aria-label={t("pagination.jumpToPage")}
          disabled={disabled}
          inputMode="numeric"
          autoFocus
          className="border-input text-muted-foreground focus:ring-ring/20 h-10 w-14 rounded-lg border bg-white text-center text-sm tabular-nums shadow-sm outline-none focus:ring-2"
          value={editValue}
          placeholder={String(page)}
          onChange={(e) => setEditValue(e.target.value.replace(/\D/g, ""))}
          onKeyDown={(e) => {
            if (e.key === "Enter") handleSubmit();
            if (e.key === "Escape") setEditValue(null);
          }}
          onBlur={handleSubmit}
        />
      ) : (
        <button
          type="button"
          disabled={disabled}
          className="text-muted-foreground hover:text-foreground min-h-10 cursor-pointer rounded-lg px-2 text-sm tabular-nums transition-colors hover:bg-slate-100"
          onClick={() => setEditValue("")}
          title={t("pagination.jumpToPage")}
        >
          {page} / {totalPages}
        </button>
      )}
      <Button
        variant="outline"
        size="sm"
        disabled={disabled || page >= totalPages}
        onClick={() => onPageChange(page + 1)}
        aria-label={t("pagination.next")}
      >
        <ChevronRight className="h-4 w-4" />
      </Button>
    </div>
  );
}
