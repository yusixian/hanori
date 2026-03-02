import { Button } from "@/components/ui/button";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { useState } from "react";

interface PaginationProps {
  page: number;
  totalPages: number;
  onPageChange: (page: number) => void;
  className?: string;
}

export function Pagination({ page, totalPages, onPageChange, className }: PaginationProps) {
  const [editValue, setEditValue] = useState<string | null>(null);

  if (totalPages <= 1) return null;

  const handleSubmit = () => {
    if (editValue === null) return;
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
        disabled={page <= 1}
        onClick={() => onPageChange(page - 1)}
      >
        <ChevronLeft className="h-4 w-4" />
      </Button>
      {editValue !== null ? (
        <input
          type="text"
          inputMode="numeric"
          autoFocus
          className="text-muted-foreground border-input focus:ring-ring h-7 w-12 rounded border bg-transparent text-center text-sm outline-none focus:ring-2"
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
          className="text-muted-foreground hover:text-foreground cursor-pointer text-sm"
          onClick={() => setEditValue("")}
          title="点击跳转页码"
        >
          {page} / {totalPages}
        </button>
      )}
      <Button
        variant="outline"
        size="sm"
        disabled={page >= totalPages}
        onClick={() => onPageChange(page + 1)}
      >
        <ChevronRight className="h-4 w-4" />
      </Button>
    </div>
  );
}
