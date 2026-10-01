import { cn } from "@/lib/utils";
import { createContext, useContext, type HTMLAttributes, type ReactNode } from "react";

const EmbeddedCardContext = createContext(false);

export function EmbeddedCardProvider({ children }: { children: ReactNode }) {
  return <EmbeddedCardContext.Provider value>{children}</EmbeddedCardContext.Provider>;
}

export function Card({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  const embedded = useContext(EmbeddedCardContext);
  return (
    <div
      className={cn(
        embedded
          ? "bg-transparent text-card-foreground"
          : "ui-card rounded-xl border bg-card text-card-foreground shadow-[var(--shadow-surface)]",
        className,
      )}
      {...props}
    />
  );
}

export function CardHeader({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  const embedded = useContext(EmbeddedCardContext);
  if (embedded) return null;
  return <div className={cn("flex flex-col space-y-1.5 p-5 sm:p-6", className)} {...props} />;
}

export function CardTitle({ className, ...props }: HTMLAttributes<HTMLHeadingElement>) {
  return (
    <h3
      className={cn("text-lg font-semibold leading-tight tracking-tight", className)}
      {...props}
    />
  );
}

export function CardDescription({ className, ...props }: HTMLAttributes<HTMLParagraphElement>) {
  return (
    <p
      className={cn("text-pretty text-sm leading-6 text-muted-foreground", className)}
      {...props}
    />
  );
}

export function CardContent({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  const embedded = useContext(EmbeddedCardContext);
  return <div className={cn(embedded ? "p-0" : "p-5 pt-0 sm:p-6 sm:pt-0", className)} {...props} />;
}
