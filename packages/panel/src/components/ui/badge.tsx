import { cn } from "@/lib/utils";
import type { HTMLAttributes } from "react";

const variants = {
  default: "border-input bg-white text-foreground",
  success: "border-success-border bg-success-soft text-success",
  warning: "border-warning-border bg-warning-soft text-warning",
  destructive: "border-danger-border bg-danger-soft text-destructive",
  muted: "border-border bg-background text-muted-foreground",
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
