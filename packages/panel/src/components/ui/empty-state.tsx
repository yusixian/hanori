import { cn } from "@/lib/utils";
import type { LucideIcon } from "lucide-react";
import type { ReactNode } from "react";

export function EmptyState({
  icon: Icon,
  title,
  description,
  children,
  className,
}: {
  icon: LucideIcon;
  title: string;
  description: string;
  children?: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "flex items-start gap-4 rounded-2xl border border-border bg-white/70 p-5 sm:p-6",
        className,
      )}
    >
      <span className="bg-accent text-primary flex size-10 shrink-0 items-center justify-center rounded-xl">
        <Icon className="size-5" aria-hidden="true" />
      </span>
      <div className="min-w-0 flex-1">
        <p className="text-foreground font-semibold">{title}</p>
        <p className="text-muted-foreground mt-1 max-w-prose text-sm leading-6">{description}</p>
        {children && <div className="mt-4 flex flex-wrap gap-2">{children}</div>}
      </div>
    </div>
  );
}
