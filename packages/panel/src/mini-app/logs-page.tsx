import type { LogLevel } from "@cos-tool-bot/shared";
import { AlertTriangle, ChevronDown, RefreshCw } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { fetchMiniAppLogs, type MiniAppLogEntry } from "./logs";

interface LogsPageProps {
  botId: string;
}

const LEVELS: readonly (LogLevel | "")[] = ["", "debug", "info", "warn", "error"];

function formatTimestamp(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? value
    : new Intl.DateTimeFormat(undefined, {
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
      }).format(date);
}

function LogMetadata({ log }: { log: MiniAppLogEntry }) {
  const { t } = useTranslation("miniApp");
  const entries = [
    log.meta.command
      ? { label: t("logs.meta.command"), value: `/${log.meta.command}`, isId: false }
      : null,
    log.meta.chatType
      ? { label: t("logs.meta.chatType"), value: log.meta.chatType, isId: false }
      : null,
    log.meta.updateId
      ? { label: t("logs.meta.updateId"), value: String(log.meta.updateId), isId: true }
      : null,
    log.meta.messageId
      ? { label: t("logs.meta.messageId"), value: String(log.meta.messageId), isId: true }
      : null,
  ].filter((entry): entry is { label: string; value: string; isId: boolean } => entry !== null);
  if (entries.length === 0) return null;
  return (
    <dl className="mini-logs-meta">
      {entries.map((entry) => (
        <div key={entry.label}>
          <dt>{entry.label}</dt>
          <dd className={entry.isId ? "is-id" : undefined}>{entry.value}</dd>
        </div>
      ))}
    </dl>
  );
}

export function LogsPage({ botId }: LogsPageProps) {
  const { t } = useTranslation("miniApp");
  const [logs, setLogs] = useState<MiniAppLogEntry[]>([]);
  const [nextCursor, setNextCursor] = useState<number | null>(null);
  const [level, setLevel] = useState<LogLevel | "">("");
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [failureMode, setFailureMode] = useState<"replace" | "append" | null>(null);
  const requestVersion = useRef(0);

  const load = useCallback(
    async (mode: "replace" | "append" = "replace", before?: number | null) => {
      const version = ++requestVersion.current;
      setFailureMode(null);
      mode === "append" ? setLoadingMore(true) : setLoading(true);
      try {
        const page = await fetchMiniAppLogs(botId, {
          ...(mode === "append" && before ? { before } : {}),
          ...(level ? { level } : {}),
        });
        if (version !== requestVersion.current) return;
        setLogs((current) => (mode === "append" ? [...current, ...page.logs] : page.logs));
        setNextCursor(page.nextCursor);
      } catch {
        if (version === requestVersion.current) setFailureMode(mode);
      } finally {
        if (version === requestVersion.current) {
          setLoading(false);
          setLoadingMore(false);
        }
      }
    },
    [botId, level],
  );

  useEffect(() => {
    void load();
    return () => {
      requestVersion.current += 1;
    };
  }, [load]);

  return (
    <main className="mini-app-content mini-logs">
      <header className="mini-logs-heading">
        <div>
          <p>{t("logs.eyebrow")}</p>
          <h1>{t("logs.title")}</h1>
        </div>
        <span>{t("logs.count", { count: logs.length })}</span>
      </header>

      <div className="mini-logs-toolbar">
        <label>
          <span className="sr-only">{t("logs.levelLabel")}</span>
          <select
            aria-label={t("logs.levelLabel")}
            onChange={(event) => setLevel(event.target.value as LogLevel | "")}
            value={level}
          >
            {LEVELS.map((candidate) => (
              <option key={candidate || "all"} value={candidate}>
                {t(candidate ? `logs.level.${candidate}` : "logs.level.all")}
              </option>
            ))}
          </select>
          <ChevronDown aria-hidden="true" />
        </label>
        <button
          aria-label={t("logs.refresh")}
          disabled={loading}
          onClick={() => void load()}
          type="button"
        >
          <RefreshCw aria-hidden="true" className={loading ? "is-spinning" : undefined} />
        </button>
      </div>

      {failureMode === "replace" ? (
        <section className="mini-logs-state is-error" role="alert">
          <AlertTriangle aria-hidden="true" />
          <div>
            <strong>{t("logs.errorTitle")}</strong>
            <span>{t("logs.errorBody")}</span>
          </div>
          <button onClick={() => void load()} type="button">
            {t("logs.retry")}
          </button>
        </section>
      ) : loading ? (
        <p className="mini-logs-state" role="status">
          {t("logs.loading")}
        </p>
      ) : logs.length === 0 ? (
        <p className="mini-logs-state">{t(level ? "logs.noMatches" : "logs.empty")}</p>
      ) : (
        <section className="mini-logs-list" aria-label={t("logs.listLabel")}>
          {logs.map((log) => (
            <article key={log.id}>
              <header>
                <span className={`mini-logs-level is-${log.level}`}>{log.level}</span>
                <time dateTime={log.createdAt}>{formatTimestamp(log.createdAt)}</time>
                <code>#{log.id}</code>
              </header>
              <p>{log.message}</p>
              <LogMetadata log={log} />
            </article>
          ))}
        </section>
      )}

      {failureMode === "append" && nextCursor ? (
        <section className="mini-logs-state is-error is-append" role="alert">
          <AlertTriangle aria-hidden="true" />
          <div>
            <strong>{t("logs.errorTitle")}</strong>
            <span>{t("logs.errorBody")}</span>
          </div>
          <button onClick={() => void load("append", nextCursor)} type="button">
            {t("logs.retry")}
          </button>
        </section>
      ) : null}

      {nextCursor && failureMode !== "append" ? (
        <button
          className="mini-logs-more"
          disabled={loadingMore}
          onClick={() => void load("append", nextCursor)}
          type="button"
        >
          {loadingMore ? t("logs.loadingMore") : t("logs.loadMore")}
        </button>
      ) : null}
    </main>
  );
}
