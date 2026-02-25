import { collapseAllNested, darkStyles, JsonView } from "react-json-view-lite";
import "react-json-view-lite/dist/index.css";

export type LogMeta = Record<string, unknown> | null | undefined;

function isComplexValue(value: unknown): value is object {
  return typeof value === "object" && value !== null;
}

export function LogMetaDisplay({ meta }: { meta: LogMeta }) {
  if (!meta || typeof meta !== "object") return null;
  const entries = Object.entries(meta).filter(([, v]) => v != null && v !== "");
  if (entries.length === 0) return null;

  const simple = entries.filter(([, v]) => !isComplexValue(v));
  const complex = entries.filter(([, v]) => isComplexValue(v));

  return (
    <div className="mt-1 space-y-1">
      {simple.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {simple.map(([key, value]) => (
            <span
              key={key}
              className="bg-muted text-muted-foreground inline-flex items-center gap-1 rounded px-1.5 py-0.5 font-mono text-[11px]"
            >
              <span className="text-primary/70">{key}:</span>
              <span className="max-w-[300px] truncate">{String(value)}</span>
            </span>
          ))}
        </div>
      )}
      {complex.map(([key, value]) => (
        <div key={key} className="bg-muted/50 rounded px-2 py-1 font-mono text-[11px]">
          <span className="text-primary/70 mr-1">{key}:</span>
          <JsonView
            data={value as object}
            style={darkStyles}
            shouldExpandNode={collapseAllNested}
          />
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

export function formatTime(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleString("zh-CN", { hour12: false });
}
