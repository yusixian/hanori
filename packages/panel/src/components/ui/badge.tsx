import { cn } from "@/lib/utils";
import type { HTMLAttributes } from "react";

const variants = {
  default: "border-slate-300 bg-white text-slate-700",
  success: "border-slate-300 bg-white text-slate-700",
  warning: "border-slate-300 bg-white text-slate-700",
  destructive: "border-red-200 bg-white text-red-700",
  muted: "border-slate-200 bg-slate-50 text-slate-600",
} as const;

interface BadgeProps extends HTMLAttributes<HTMLSpanElement> {
  variant?: keyof typeof variants;
}

export function Badge({ className, variant = "default", ...props }: BadgeProps) {
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-md border px-2 py-0.5 text-xs font-medium",
        variants[variant],
        className,
      )}
      {...props}
    />
  );
}
