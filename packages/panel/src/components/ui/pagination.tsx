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
        aria-label="上一页"
      >
        <ChevronLeft className="h-4 w-4" />
      </Button>
      {editValue !== null ? (
        <input
          type="text"
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
          className="text-muted-foreground hover:text-foreground min-h-10 cursor-pointer rounded-lg px-2 text-sm tabular-nums transition-colors hover:bg-slate-100"
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
        aria-label="下一页"
      >
        <ChevronRight className="h-4 w-4" />
      </Button>
    </div>
  );
}
