import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { triggerDownload } from "@/lib/download";
import type { MediaJobView } from "@cos-tool-bot/shared";
import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";
import {
  mediaJobsApi,
  type MediaJobsApi,
  type MediaJobsList,
  type MediaTranscriptPage,
} from "./media-jobs-api";

const cancellable = new Set([
  "pending_confirmation",
  "queued",
  "downloading",
  "converting",
  "transcribing",
]);
function time(milliseconds: number | null) {
  if (milliseconds === null) return "—";
  const seconds = Math.floor(milliseconds / 1000);
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}
export function MediaJobsPanel({
  botId,
  api = mediaJobsApi,
}: {
  botId: string;
  api?: MediaJobsApi;
}) {
  return <JobsContent key={botId} botId={botId} api={api} />;
}
function JobsContent({ botId, api }: { botId: string; api: MediaJobsApi }) {
  const { t } = useTranslation("plugins");
  const [list, setList] = useState<MediaJobsList | null>(null);
  const [refresh, setRefresh] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [cancelling, setCancelling] = useState<string | null>(null);
  const alive = useRef(false);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  useEffect(() => {
    let active = true;
    setLoading(true);
    setError(false);
    api
      .list(botId)
      .then((value) => {
        if (!active) return;
        setList(value);
        setSelectedId((id) => (value.data.some((job) => job.id === id) ? id : null));
      })
      .catch(() => {
        if (active) setError(true);
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [api, botId, refresh]);
  async function cancel(jobId: string) {
    setCancelling(jobId);
    setError(false);
    try {
      await api.cancel(botId, jobId);
      if (alive.current) setRefresh((value) => value + 1);
    } catch {
      if (alive.current) setError(true);
    } finally {
      if (alive.current) setCancelling(null);
    }
  }
  const selected = list?.data.find((job) => job.id === selectedId);
  return (
    <section aria-label={t("jobs.title")} className="min-w-0 space-y-4 rounded-xl border p-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0">
          <h3 className="font-semibold">{t("jobs.title")}</h3>
          <p className="text-muted-foreground mt-1 text-sm">{t("jobs.description")}</p>
        </div>
        <Button
          variant="outline"
          disabled={loading || cancelling !== null}
          onClick={() => setRefresh((value) => value + 1)}
        >
          {t("jobs.refresh")}
        </Button>
      </div>
      {error ? (
        <p role="alert" className="text-destructive text-sm">
          {t("jobs.failed")}
        </p>
      ) : null}
      {loading ? <p role="status">{t("loading")}</p> : null}
      {list && !list.available ? (
        <p className="text-muted-foreground text-sm">{t("jobs.unavailable")}</p>
      ) : null}
      {!loading && list?.data.length === 0 ? (
        <p className="text-muted-foreground text-sm">{t("jobs.empty")}</p>
      ) : null}
      <ul className="space-y-2">
        {list?.data.slice(0, 50).map((job) => (
          <li
            key={job.id}
            className="flex min-w-0 flex-wrap items-start justify-between gap-3 rounded-lg border p-3"
          >
            <div className="min-w-0 flex-1 basis-48 space-y-1">
              <p className="font-medium [overflow-wrap:anywhere]">{job.title}</p>
              <p className="text-muted-foreground text-xs">
                {t("jobs.resource", { part: job.part, duration: time(job.durationSeconds * 1000) })}
              </p>
              <p className="text-muted-foreground text-xs break-all">
                {t("jobs.jobId", { id: job.id })}
              </p>
              <Badge
                variant={
                  job.status === "completed"
                    ? "success"
                    : job.status === "failed"
                      ? "destructive"
                      : "muted"
                }
              >
                {t(`jobs.status.${job.status}`)} · {job.progress}%
              </Badge>
              {job.status === "failed" ? (
                <p className="text-destructive text-xs">
                  {t(
                    job.error === "provider_cancellation_unavailable"
                      ? "jobs.cloudCancellation"
                      : "jobs.jobFailed",
                  )}
                </p>
              ) : null}
            </div>
            <div className="flex flex-wrap gap-2">
              {job.status === "completed" ? (
                <Button
                  variant="outline"
                  disabled={!list.available}
                  aria-pressed={selectedId === job.id}
                  onClick={() => setSelectedId(job.id)}
                >
                  {t("jobs.view")}
                </Button>
              ) : null}
              {cancellable.has(job.status) ? (
                <Button
                  variant="outline"
                  disabled={cancelling !== null || loading}
                  onClick={() => void cancel(job.id)}
                >
                  {t(cancelling === job.id ? "jobs.cancelling" : "jobs.cancel")}
                </Button>
              ) : null}
            </div>
          </li>
        ))}
      </ul>
      {selected?.status === "completed" && list?.available ? (
        <TranscriptViewer
          key={`${selected.id}:${list.allowExport}:${refresh}`}
          botId={botId}
          job={selected}
          api={api}
          allowExport={list.allowExport}
        />
      ) : null}
    </section>
  );
}
function TranscriptViewer({
  botId,
  job,
  api,
  allowExport,
}: {
  botId: string;
  job: MediaJobView;
  api: MediaJobsApi;
  allowExport: boolean;
}) {
  const { t, i18n } = useTranslation("plugins");
  const inputId = useId();
  const rightsId = useId();
  const [draft, setDraft] = useState("");
  const [query, setQuery] = useState("");
  const [offsets, setOffsets] = useState([0]);
  const [request, setRequest] = useState(0);
  const [data, setData] = useState<MediaTranscriptPage | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [rights, setRights] = useState(false);
  const [exporting, setExporting] = useState(false);
  const alive = useRef(false);
  const offset = offsets.at(-1)!;
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  useEffect(() => {
    let active = true;
    setLoading(true);
    setError(false);
    setData(null);
    api
      .transcript(botId, job.id, { offset, limit: 40, ...(query ? { query } : {}) })
      .then((value) => {
        if (active) setData(value);
      })
      .catch(() => {
        if (active) setError(true);
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [api, botId, job.id, offset, query, request]);
  function search(event: FormEvent) {
    event.preventDefault();
    setOffsets([0]);
    setQuery(draft.trim());
    setRequest((value) => value + 1);
  }
  async function download(format: "srt" | "vtt") {
    if (!rights || !allowExport || exporting) return;
    setExporting(true);
    setError(false);
    try {
      const blob = await api.export(botId, job.id, format);
      if (alive.current) triggerDownload(blob, `transcript-${job.id}.${format}`);
    } catch {
      if (alive.current) setError(true);
    } finally {
      if (alive.current) setExporting(false);
    }
  }
  let remaining = 4000;
  const cues =
    data?.cues
      .slice(0, 40)
      .map((cue) => {
        const text = cue.text.slice(0, remaining);
        remaining -= text.length;
        return { ...cue, text, textTruncated: cue.textTruncated || text.length < cue.text.length };
      })
      .filter((cue) => cue.text.length > 0) ?? [];
  const truncated =
    data?.textTruncated ||
    cues.some((cue) => cue.textTruncated) ||
    (data?.cues.length ?? 0) > cues.length;
  return (
    <section aria-label={t("jobs.transcript")} className="min-w-0 space-y-3 border-t pt-4">
      <h4 className="font-semibold [overflow-wrap:anywhere]">{job.title}</h4>
      <p className="text-muted-foreground text-sm">{t("jobs.asrNotice")}</p>
      <p className="text-muted-foreground text-xs">
        {t("jobs.expires", { date: new Date(job.expiresAt).toLocaleString(i18n.language) })}
      </p>
      {job.notification === "failed" ? (
        <p className="text-muted-foreground text-sm">{t("jobs.noticeFailed")}</p>
      ) : null}
      <form onSubmit={search} className="flex flex-wrap items-end gap-2">
        <div className="min-w-0 flex-1 basis-48 space-y-1">
          <Label htmlFor={inputId}>{t("jobs.keyword")}</Label>
          <Input
            id={inputId}
            maxLength={200}
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
          />
        </div>
        <Button type="submit" variant="outline" disabled={loading}>
          {t("jobs.search")}
        </Button>
      </form>
      {error ? (
        <p role="alert" className="text-destructive text-sm">
          {t("jobs.transcriptFailed")}
        </p>
      ) : null}
      {loading ? <p role="status">{t("loading")}</p> : null}
      {data ? (
        <>
          <p className="text-muted-foreground text-xs">
            {t("jobs.page", {
              start: cues.length ? data.offset + 1 : 0,
              end: data.offset + cues.length,
              total: data.total,
            })}
          </p>
          {cues.length === 0 ? (
            <p className="text-muted-foreground text-sm">{t("jobs.noMatches")}</p>
          ) : null}
          <ol className="space-y-3">
            {cues.map((cue) => (
              <li key={cue.cueIndex} className="bg-muted/50 min-w-0 rounded-lg p-3">
                <p className="text-muted-foreground mb-1 font-mono text-xs">
                  {time(cue.startMs)}–{time(cue.endMs)}
                </p>
                <p className="text-sm [overflow-wrap:anywhere] whitespace-pre-wrap">{cue.text}</p>
              </li>
            ))}
          </ol>
          {truncated ? (
            <p className="text-muted-foreground text-sm">{t("jobs.truncated")}</p>
          ) : null}
          <div className="flex flex-wrap gap-2">
            <Button
              variant="outline"
              disabled={loading || offsets.length < 2}
              onClick={() => setOffsets((value) => value.slice(0, -1))}
            >
              {t("jobs.previous")}
            </Button>
            <Button
              variant="outline"
              disabled={loading || data.nextOffset === null}
              onClick={() =>
                data.nextOffset !== null && setOffsets((value) => [...value, data.nextOffset!])
              }
            >
              {t("jobs.next")}
            </Button>
          </div>
        </>
      ) : null}
      {allowExport ? (
        <div className="space-y-3 border-t pt-3">
          <label htmlFor={rightsId} className="flex items-start gap-2 text-sm">
            <input
              id={rightsId}
              type="checkbox"
              className="mt-1 h-4 w-4 shrink-0"
              checked={rights}
              onChange={(event) => setRights(event.target.checked)}
            />
            <span>{t("jobs.rights")}</span>
          </label>
          <div className="flex flex-wrap gap-2">
            {(["srt", "vtt"] as const).map((format) => (
              <Button
                key={format}
                variant="outline"
                disabled={!rights || exporting}
                onClick={() => void download(format)}
              >
                {t("jobs.download", { format: format.toUpperCase() })}
              </Button>
            ))}
          </div>
        </div>
      ) : (
        <p className="text-muted-foreground text-sm">{t("jobs.exportDisabled")}</p>
      )}
    </section>
  );
}
