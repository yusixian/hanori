import { LogMetaDisplay, type LogMeta, formatTime, levelBadge } from "./log-meta-display";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import type { LogEntry } from "@cos-tool-bot/shared";
import { Check, ChevronDown, ClipboardCopy } from "lucide-react";
import { useState } from "react";

const CORRELATION_KEYS = [
  "correlationId",
  "turnId",
  "runId",
  "requestId",
  "traceId",
  "chatId",
  "messageId",
  "toolName",
] as const;

export interface LogEntryLabels {
  details: string;
  metadata: string;
  copyJson: string;
  copied: string;
}

export function logMatchesFilters(
  log: LogEntry,
  level: string,
  search: string,
  chatId = "",
  correlationId = "",
): boolean {
  if (level && log.level !== level) return false;
  const meta =
    log.meta && typeof log.meta === "object" ? (log.meta as Record<string, unknown>) : {};
  if (chatId && String(meta.chatId ?? "") !== chatId.trim()) return false;
  if (correlationId && String(meta.correlationId ?? "") !== correlationId.trim()) return false;
  const needle = search.trim().toLocaleLowerCase();
  if (!needle) return true;
  const searchable = `${log.message}\n${JSON.stringify(log.meta ?? {})}`.toLocaleLowerCase();
  return searchable.includes(needle);
}

export function mergeLogEntries(
  history: readonly LogEntry[],
  live: readonly LogEntry[],
): LogEntry[] {
  const byId = new Map<number, LogEntry>();
  for (const log of [...live, ...history]) {
    if (!byId.has(log.id)) byId.set(log.id, log);
  }
  return [...byId.values()].sort((left, right) => right.id - left.id);
}

function correlationEntries(meta: LogMeta): Array<[string, string]> {
  if (!meta || typeof meta !== "object") return [];
  return CORRELATION_KEYS.flatMap((key) => {
    const value = meta[key];
    return value === undefined || value === null || value === ""
      ? []
      : ([[key, String(value)]] as Array<[string, string]>);
  }).slice(0, 4);
}

export function LogEntryRow({
  log,
  locale,
  labels,
  showBotId = false,
  live = false,
}: {
  log: LogEntry;
  locale?: string;
  labels: LogEntryLabels;
  showBotId?: boolean;
  live?: boolean;
}) {
  const [copied, setCopied] = useState(false);
  const correlations = correlationEntries(log.meta as LogMeta);

  const copyJson = async () => {
    try {
      await navigator.clipboard.writeText(JSON.stringify(log, null, 2));
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1_500);
    } catch {
      setCopied(false);
    }
  };

  return (
    <article className={live ? "bg-blue-50/50" : undefined} data-log-id={log.id}>
      <details className="group">
        <summary className="focus-visible:ring-ring cursor-pointer list-none px-4 py-3.5 focus-visible:ring-2 focus-visible:outline-none focus-visible:ring-inset [&::-webkit-details-marker]:hidden">
          <div className="flex min-w-0 items-start gap-3">
            <Badge variant={levelBadge[log.level] ?? "muted"} className="mt-0.5 shrink-0 uppercase">
              {log.level}
            </Badge>
            <div className="min-w-0 flex-1 space-y-2">
              <p className="text-foreground font-mono text-sm leading-5 break-words whitespace-pre-wrap">
                {log.message}
              </p>
              <div className="text-muted-foreground flex flex-wrap items-center gap-x-3 gap-y-1 font-mono text-[11px]">
                <time dateTime={log.createdAt}>{formatTime(log.createdAt, locale)}</time>
                {showBotId && log.botId && <span>botId: {log.botId}</span>}
                {correlations.map(([key, value]) => (
                  <span key={key} className="max-w-full break-all">
                    {key}: {value}
                  </span>
                ))}
              </div>
            </div>
            <span className="text-muted-foreground mt-0.5 inline-flex shrink-0 items-center gap-1 text-xs">
              <span className="hidden sm:inline">{labels.details}</span>
              <ChevronDown
                className="size-4 transition-transform duration-150 group-open:rotate-180"
                aria-hidden="true"
              />
            </span>
          </div>
        </summary>
        <div className="border-t bg-slate-50/70 px-4 py-3.5">
          <div className="mb-3 flex items-center justify-between gap-3">
            <p className="text-sm font-semibold">{labels.metadata}</p>
            <Button variant="outline" size="sm" onClick={() => void copyJson()}>
              {copied ? <Check className="size-3.5" /> : <ClipboardCopy className="size-3.5" />}
              {copied ? labels.copied : labels.copyJson}
            </Button>
          </div>
          <LogMetaDisplay meta={log.meta as LogMeta} />
        </div>
      </details>
    </article>
  );
}
