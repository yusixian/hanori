import { cn } from "@/lib/utils";
import { EmbeddedCardProvider } from "@/components/ui/card";
import { ChevronDown } from "lucide-react";
import { useId, useState, type ReactNode } from "react";

export function SettingsDisclosureRow({
  title,
  description,
  summary,
  defaultOpen = false,
  flattenCard = true,
  children,
}: {
  title: string;
  description?: string;
  summary?: ReactNode;
  defaultOpen?: boolean;
  flattenCard?: boolean;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const contentId = useId();

  return (
    <section
      className={cn(
        "overflow-hidden rounded-2xl bg-white shadow-[var(--shadow-surface)] ring-1 transition-[box-shadow,ring-color]",
        open
          ? "ring-blue-600/15 shadow-[0_12px_32px_rgb(15_23_42/0.07)]"
          : "ring-slate-950/[0.035] hover:ring-slate-950/[0.08]",
      )}
    >
      <button
        type="button"
        aria-expanded={open}
        aria-controls={contentId}
        onClick={() => setOpen((value) => !value)}
        className={cn(
          "group relative flex min-h-20 w-full items-center gap-4 px-5 py-4 text-left transition-colors sm:px-6",
          open ? "bg-blue-50/45" : "hover:bg-slate-50/70",
        )}
      >
        <span
          aria-hidden="true"
          className={cn(
            "absolute inset-y-4 left-0 w-[3px] rounded-r-full bg-blue-600 transition-opacity",
            open ? "opacity-100" : "opacity-0",
          )}
        />
        <span className="min-w-0 flex-1">
          <span
            className={cn("block text-sm font-semibold", open ? "text-blue-950" : "text-slate-950")}
          >
            {title}
          </span>
          {description && (
            <span className="mt-1 block text-xs leading-5 text-pretty text-slate-500">
              {description}
            </span>
          )}
        </span>
        {summary && (
          <span className="hidden shrink-0 rounded-full bg-slate-100 px-2.5 py-1 text-[11px] font-semibold text-slate-600 lg:block">
            {summary}
          </span>
        )}
        <span className="flex size-10 shrink-0 items-center justify-center rounded-lg text-slate-400 transition-colors group-hover:bg-slate-100 group-hover:text-slate-700">
          <ChevronDown
            className={cn("size-4 transition-transform duration-200", open && "rotate-180")}
          />
        </span>
      </button>
      {open && (
        <div id={contentId} className="border-t border-slate-100 bg-white px-5 py-5 sm:px-6">
          {flattenCard ? <EmbeddedCardProvider>{children}</EmbeddedCardProvider> : children}
        </div>
      )}
    </section>
  );
}
