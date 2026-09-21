import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { Search, X } from "lucide-react";
import { useEffect, useId, useMemo, useRef, useState } from "react";
import type { AiSettingId } from "../settings-index";

export interface AiSettingsSearchItem {
  id: AiSettingId;
  label: string;
  description: string;
  sectionLabel: string;
}

export function AiSettingsSearch({
  items,
  onSelect,
  labels,
}: {
  items: AiSettingsSearchItem[];
  onSelect: (id: AiSettingId) => void;
  labels: {
    search: string;
    clear: string;
    noResults: string;
    resultCount: (count: number) => string;
  };
}) {
  const [query, setQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);
  const [focused, setFocused] = useState(false);
  const listboxId = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  const listboxRef = useRef<HTMLDivElement>(null);
  const normalizedQuery = query.trim().toLocaleLowerCase();
  const results = useMemo(() => {
    if (!normalizedQuery) return [];
    return items.filter((item) =>
      [item.label, item.description, item.sectionLabel]
        .join(" ")
        .toLocaleLowerCase()
        .includes(normalizedQuery),
    );
  }, [items, normalizedQuery]);
  const safeActiveIndex = results.length === 0 ? 0 : Math.min(activeIndex, results.length - 1);
  const open = focused && normalizedQuery.length > 0;

  useEffect(() => {
    if (!open || !results[safeActiveIndex]) return;
    const activeOption = document.getElementById(`${listboxId}-${results[safeActiveIndex].id}`);
    const listbox = listboxRef.current;
    if (!activeOption || !listbox?.contains(activeOption)) return;

    const optionBounds = activeOption.getBoundingClientRect();
    const listboxBounds = listbox.getBoundingClientRect();
    if (optionBounds.top < listboxBounds.top || optionBounds.bottom > listboxBounds.bottom) {
      activeOption.scrollIntoView({ block: "nearest" });
    }
  }, [listboxId, open, results, safeActiveIndex]);

  const clear = () => {
    setQuery("");
    setActiveIndex(0);
  };

  const clearAndFocusSearch = () => {
    clear();
    inputRef.current?.focus();
  };

  const select = (id: AiSettingId) => {
    clear();
    onSelect(id);
  };

  return (
    <div
      className="relative max-w-xl"
      onFocusCapture={() => setFocused(true)}
      onBlurCapture={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setFocused(false);
      }}
    >
      <label className="relative block">
        <span className="sr-only">{labels.search}</span>
        <Search
          aria-hidden="true"
          className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-slate-400"
        />
        <Input
          ref={inputRef}
          type="search"
          name="ai-settings-search"
          autoComplete="off"
          value={query}
          onChange={(event) => {
            setQuery(event.target.value);
            setActiveIndex(0);
          }}
          onKeyDown={(event) => {
            if (event.nativeEvent.isComposing || event.keyCode === 229) return;
            if (!open) return;
            if (event.key === "ArrowDown") {
              event.preventDefault();
              setActiveIndex((index) => Math.min(index + 1, Math.max(results.length - 1, 0)));
            } else if (event.key === "ArrowUp") {
              event.preventDefault();
              setActiveIndex((index) => Math.max(index - 1, 0));
            } else if (event.key === "Enter" && results[safeActiveIndex]) {
              event.preventDefault();
              select(results[safeActiveIndex].id);
            } else if (event.key === "Escape") {
              event.preventDefault();
              clear();
            }
          }}
          className="h-11 bg-white pr-10 pl-10 [&::-webkit-search-cancel-button]:appearance-none"
          placeholder={labels.search}
          aria-label={labels.search}
          role="combobox"
          aria-autocomplete="list"
          aria-expanded={open}
          aria-controls={open ? listboxId : undefined}
          aria-activedescendant={
            open && results[safeActiveIndex]
              ? `${listboxId}-${results[safeActiveIndex].id}`
              : undefined
          }
        />
        {query && (
          <button
            type="button"
            onClick={clearAndFocusSearch}
            aria-label={labels.clear}
            className="focus-visible:ring-ring absolute top-1/2 right-1.5 flex size-8 -translate-y-1/2 items-center justify-center rounded-lg text-slate-400 transition-colors hover:bg-slate-100 hover:text-slate-700 focus-visible:ring-2 focus-visible:outline-none"
          >
            <X aria-hidden="true" className="size-4" />
          </button>
        )}
      </label>

      {open && (
        <div
          ref={listboxRef}
          id={listboxId}
          role="listbox"
          aria-label={labels.search}
          className="absolute top-full right-0 left-0 z-30 mt-2 max-h-80 overflow-y-auto rounded-xl border border-slate-200 bg-white p-1.5 shadow-[0_16px_40px_rgb(15_23_42/0.18)]"
        >
          <p className="sr-only" role="status" aria-live="polite">
            {labels.resultCount(results.length)}
          </p>
          {results.length > 0 ? (
            results.map((item, index) => (
              <button
                key={item.id}
                id={`${listboxId}-${item.id}`}
                type="button"
                role="option"
                tabIndex={-1}
                aria-selected={index === safeActiveIndex}
                onMouseEnter={() => setActiveIndex(index)}
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => select(item.id)}
                className={cn(
                  "flex w-full items-start gap-3 rounded-lg px-3 py-2.5 text-left transition-colors",
                  index === safeActiveIndex ? "bg-blue-50 text-blue-950" : "hover:bg-slate-50",
                )}
              >
                <span className="min-w-0 flex-1">
                  <span className="block text-sm font-semibold">{item.label}</span>
                  <span className="mt-0.5 block text-xs leading-5 text-slate-500">
                    {item.description}
                  </span>
                </span>
                <span className="mt-0.5 shrink-0 rounded-full bg-slate-100 px-2 py-0.5 text-[11px] font-semibold text-slate-600">
                  {item.sectionLabel}
                </span>
              </button>
            ))
          ) : (
            <div className="flex items-center justify-between gap-3 px-3 py-3">
              <p className="text-sm text-slate-500">{labels.noResults}</p>
              <button
                type="button"
                onClick={clearAndFocusSearch}
                className="focus-visible:ring-ring shrink-0 rounded-lg px-2.5 py-1.5 text-xs font-semibold text-blue-700 hover:bg-blue-50 focus-visible:ring-2 focus-visible:outline-none"
              >
                {labels.clear}
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
