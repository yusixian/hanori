import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Popover } from "@/components/ui/popover";
import { Check, ChevronDown, Loader2, Search } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

export interface GovernanceSubjectOption {
  value: string;
  label: string;
  detail: string;
}

interface GovernanceSubjectPickerProps {
  label: string;
  value: string;
  onValueChange: (value: string) => void;
  loadOptions: (query: string, signal: AbortSignal) => Promise<GovernanceSubjectOption[]>;
  resolveOption: (
    value: string,
    signal: AbortSignal,
  ) => Promise<GovernanceSubjectOption | undefined>;
  placeholder: string;
  searchPlaceholder: string;
  emptyText: string;
  unknownText: (value: string) => string;
  loadErrorText: string;
  invalid?: boolean;
}

export function GovernanceSubjectPicker({
  label,
  value,
  onValueChange,
  loadOptions,
  resolveOption,
  placeholder,
  searchPlaceholder,
  emptyText,
  unknownText,
  loadErrorText,
  invalid = false,
}: GovernanceSubjectPickerProps) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [options, setOptions] = useState<GovernanceSubjectOption[]>([]);
  const [selected, setSelected] = useState<GovernanceSubjectOption>();
  const [loading, setLoading] = useState(false);
  const [loadFailed, setLoadFailed] = useState(false);

  useEffect(() => setSelected(undefined), [resolveOption]);

  useEffect(() => {
    if (!value || selected?.value === value) return;
    const controller = new AbortController();
    void resolveOption(value, controller.signal)
      .then((selectedOption) => {
        if (controller.signal.aborted) return;
        if (selectedOption) setSelected(selectedOption);
      })
      .catch(() => undefined);
    return () => controller.abort();
  }, [resolveOption, selected?.value, value]);

  useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    const timer = window.setTimeout(
      () => {
        setLoading(true);
        setLoadFailed(false);
        void loadOptions(query, controller.signal)
          .then((nextOptions) => {
            if (controller.signal.aborted) return;
            setOptions(nextOptions);
            const selectedOption = nextOptions.find((option) => option.value === value);
            if (selectedOption) setSelected(selectedOption);
          })
          .catch((error: unknown) => {
            if (controller.signal.aborted) return;
            if (!(error instanceof DOMException && error.name === "AbortError")) {
              setOptions([]);
              setLoadFailed(true);
            }
          })
          .finally(() => {
            if (!controller.signal.aborted) setLoading(false);
          });
      },
      query ? 180 : 0,
    );
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [loadOptions, open, query, value]);

  useEffect(() => {
    if (!value) setSelected(undefined);
    else if (selected?.value !== value) setSelected(undefined);
  }, [selected?.value, value]);

  const visibleLabel = useMemo(() => {
    if (!value) return placeholder;
    return selected?.value === value ? selected.label : unknownText(value);
  }, [placeholder, selected, unknownText, value]);

  return (
    <Popover
      open={open}
      onOpenChange={(nextOpen) => {
        setOpen(nextOpen);
        if (!nextOpen) setQuery("");
      }}
      className="w-[min(24rem,calc(100vw-2rem))] p-2"
      trigger={
        <Button
          type="button"
          variant="outline"
          role="combobox"
          aria-label={label}
          aria-expanded={open}
          aria-invalid={invalid || undefined}
          className="w-full min-w-0 justify-between px-3 font-normal"
        >
          <span className={value ? "truncate" : "text-muted-foreground truncate"}>
            {visibleLabel}
          </span>
          <ChevronDown className="text-muted-foreground size-4 shrink-0" aria-hidden="true" />
        </Button>
      }
    >
      <div className="relative mb-2">
        <Search
          className="text-muted-foreground pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2"
          aria-hidden="true"
        />
        <Input
          autoFocus
          aria-label={searchPlaceholder}
          placeholder={searchPlaceholder}
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          className="pl-9"
        />
      </div>
      <div role="listbox" aria-label={label} className="max-h-64 space-y-1 overflow-y-auto">
        {loading ? (
          <div className="text-muted-foreground flex items-center justify-center gap-2 px-3 py-6 text-sm">
            <Loader2 className="size-4 animate-spin" aria-hidden="true" />
            <span className="sr-only">{searchPlaceholder}</span>
          </div>
        ) : loadFailed ? (
          <p className="text-destructive px-3 py-4 text-sm">{loadErrorText}</p>
        ) : options.length === 0 ? (
          <p className="text-muted-foreground px-3 py-4 text-sm">{emptyText}</p>
        ) : (
          options.map((option) => (
            <button
              key={option.value}
              type="button"
              role="option"
              aria-selected={option.value === value}
              className="hover:bg-accent focus-visible:bg-accent flex w-full items-center gap-3 rounded-lg px-3 py-2 text-left outline-none"
              onClick={() => {
                setSelected(option);
                onValueChange(option.value);
                setOpen(false);
              }}
            >
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm font-medium">{option.label}</span>
                <span className="text-muted-foreground block truncate text-xs">
                  {option.detail}
                </span>
              </span>
              {option.value === value && <Check className="size-4 shrink-0" aria-hidden="true" />}
            </button>
          ))
        )}
      </div>
    </Popover>
  );
}
