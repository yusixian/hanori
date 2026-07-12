import { cn } from "@/lib/utils";
import { ChevronDown, ChevronUp } from "lucide-react";

export function DisclosureIcon({ expanded }: { expanded: boolean }) {
  const transition =
    "absolute inset-0 size-3.5 transition-[opacity,filter,scale] duration-300 [transition-timing-function:cubic-bezier(0.2,0,0,1)]";

  return (
    <span className="relative size-3.5 shrink-0" aria-hidden="true">
      <ChevronUp
        className={cn(
          transition,
          expanded ? "scale-100 opacity-100 blur-0" : "scale-[0.25] opacity-0 blur-[4px]",
        )}
      />
      <ChevronDown
        className={cn(
          transition,
          expanded ? "scale-[0.25] opacity-0 blur-[4px]" : "scale-100 opacity-100 blur-0",
        )}
      />
    </span>
  );
}
