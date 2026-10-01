import { cn } from "@/lib/utils";
import type { TextareaHTMLAttributes } from "react";

export function Textarea({ className, ...props }: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return (
    <textarea
      className={cn(
        "border-input placeholder:text-muted-foreground focus-visible:ring-ring/20 focus-visible:border-primary flex min-h-24 w-full rounded-lg border bg-white px-3 py-2 text-base md:text-sm shadow-[var(--shadow-surface)] outline-none transition-[border-color,box-shadow] focus-visible:ring-2 disabled:cursor-not-allowed disabled:opacity-50",
        className,
      )}
      {...props}
    />
  );
}
