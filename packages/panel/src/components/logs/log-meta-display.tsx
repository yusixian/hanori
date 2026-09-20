import { getResolvedLocale } from "@/i18n";

export type LogMeta = Record<string, unknown> | null | undefined;

function isComplexValue(value: unknown): value is object {
  return typeof value === "object" && value !== null;
}

function displayValue(value: unknown): string {
  if (typeof value === "string") return value;
  return String(value);
}

function parseEmbeddedJson(field: string, value: string): unknown | undefined {
  if (field !== "responseBody") return undefined;
  try {
    const parsed: unknown = JSON.parse(value);
    return typeof parsed === "object" && parsed !== null ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function JsonBlock({ value }: { value: unknown }) {
  return (
    <pre className="overflow-x-auto rounded-lg bg-slate-950 px-3 py-2.5 text-xs leading-5 break-words whitespace-pre-wrap text-slate-100">
      {JSON.stringify(value, null, 2)}
    </pre>
  );
}

function MetaValue({ field, value }: { field: string; value: unknown }) {
  if (typeof value === "string") {
    const embeddedJson = parseEmbeddedJson(field, value);
    return embeddedJson === undefined ? (
      <pre className="text-foreground font-mono text-xs leading-5 break-words whitespace-pre-wrap">
        {value}
      </pre>
    ) : (
      <JsonBlock value={embeddedJson} />
    );
  }
  if (Array.isArray(value)) return <JsonBlock value={value} />;
  if (isComplexValue(value)) {
    return (
      <div className="space-y-2 border-l border-slate-200 pl-3">
        {Object.entries(value).map(([key, nestedValue]) => (
          <div key={key} className="space-y-1">
            <p className="text-muted-foreground font-mono text-xs break-all">{key}</p>
            <MetaValue field={key} value={nestedValue} />
          </div>
        ))}
      </div>
    );
  }
  return (
    <span className="text-foreground font-mono text-xs break-words whitespace-pre-wrap">
      {displayValue(value)}
    </span>
  );
}

export function LogMetaDisplay({ meta }: { meta: LogMeta }) {
  if (!meta || typeof meta !== "object") return null;
  const entries = Object.entries(meta).filter(([, v]) => v != null && v !== "");
  if (entries.length === 0) return null;

  const simple = entries.filter(([, v]) => !isComplexValue(v));
  const complex = entries.filter(([, v]) => isComplexValue(v));

  return (
    <div className="space-y-3">
      {simple.length > 0 && (
        <dl className="grid gap-x-4 gap-y-2 sm:grid-cols-[minmax(8rem,auto)_minmax(0,1fr)]">
          {simple.map(([key, value]) => (
            <div key={key} className="contents">
              <dt className="text-muted-foreground font-mono text-xs break-all">{key}</dt>
              <dd className="min-w-0">
                <MetaValue field={key} value={value} />
              </dd>
            </div>
          ))}
        </dl>
      )}
      {complex.map(([key, value]) => (
        <div key={key} className="space-y-1.5">
          <p className="text-muted-foreground font-mono text-xs break-all">{key}</p>
          <MetaValue field={key} value={value} />
        </div>
      ))}
    </div>
  );
}

export const levelBadge: Record<string, "default" | "success" | "warning" | "destructive"> = {
  debug: "default",
  info: "success",
  warn: "warning",
  error: "destructive",
};

export function formatTime(iso: string, locale: string | undefined = getResolvedLocale()): string {
  const d = new Date(iso);
  return new Intl.DateTimeFormat(locale, {
    dateStyle: "medium",
    timeStyle: "medium",
    hour12: false,
  }).format(d);
}
