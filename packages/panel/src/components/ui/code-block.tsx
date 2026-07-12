import { cn } from "@/lib/utils";
import type { HTMLAttributes } from "react";

export function CodeBlock({ className, children, ...props }: HTMLAttributes<HTMLPreElement>) {
  return (
    <pre
      className={cn(
        "max-h-72 overflow-auto rounded-lg bg-slate-950 p-4 font-mono text-xs leading-5 whitespace-pre-wrap text-slate-100 shadow-inner",
        className,
      )}
      {...props}
    >
      {children}
    </pre>
  );
}
