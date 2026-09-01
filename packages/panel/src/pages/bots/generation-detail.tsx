import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { CodeBlock } from "@/components/ui/code-block";
import { InlineDisclosure } from "@/components/ui/inline-disclosure";
import { authFetch } from "@/lib/client";
import {
  ArrowLeft,
  Check,
  Clipboard,
  Clock3,
  Copy,
  FileWarning,
  Loader2,
  ShieldAlert,
  Sparkles,
  Trash2,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useState, type ReactElement } from "react";
import { useTranslation } from "react-i18next";
import { Link, useNavigate, useParams } from "react-router";
import { GenerationGallery } from "./generation-gallery";
import {
  generationFileUrl,
  isGenerationDeletable,
  type GenerationDetail,
  type GenerationDetailResponse,
  type GenerationSource,
} from "./generation-types";

const ACTIVE_STATES = new Set([
  "preparing",
  "awaiting_approval",
  "queued",
  "running",
  "cancel_requested",
  "cancel_rejected",
  "pending",
]);

export function BotGenerationDetailPage() {
  const { t, i18n } = useTranslation("botData");
  const { botId, source, generationId } = useParams<{
    botId: string;
    source: GenerationSource;
    generationId: string;
  }>();
  const navigate = useNavigate();
  const [detail, setDetail] = useState<GenerationDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const locale = i18n.resolvedLanguage ?? i18n.language;
  const dateFormatter = useMemo(
    () => new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "medium" }),
    [locale],
  );

  const load = useCallback(async () => {
    if (!botId || !generationId || (source !== "unified" && source !== "legacy")) return;
    const response = await authFetch(
      `/api/bots/${encodeURIComponent(botId)}/generations/${source}/${encodeURIComponent(generationId)}`,
    );
    if (!response.ok) {
      setLoading(false);
      return;
    }
    const result = (await response.json()) as GenerationDetailResponse;
    setDetail(result.data);
    setLoading(false);
  }, [botId, generationId, source]);

  useEffect(() => void load(), [load]);
  useEffect(() => {
    if (!detail || !ACTIVE_STATES.has(detail.state)) return;
    const timer = window.setInterval(() => void load(), 4_000);
    return () => window.clearInterval(timer);
  }, [detail, load]);

  if (loading) {
    return (
      <div className="text-muted-foreground flex items-center justify-center gap-2 py-20 text-sm">
        <Loader2 className="size-4 animate-spin" />
        {t("common.loading")}
      </div>
    );
  }
  if (!detail || !botId || !source) {
    return (
      <div className="text-muted-foreground py-16 text-center">{t("generations.notFound")}</div>
    );
  }

  const snapshot = detail.requestSnapshot ?? {};
  const images = detail.localFiles.map((file) => generationFileUrl(botId, file));
  const canDelete = isGenerationDeletable(detail);
  const reproduction = {
    taskId: detail.id,
    source: detail.source,
    provider: detail.provider,
    purpose: detail.purpose,
    presetKey: detail.presetKey,
    prompt: detail.prompt,
    negativePrompt: detail.negativePrompt,
    seed: detail.seed,
    parameters: snapshot,
    artifacts: detail.artifacts,
    createdAt: detail.createdAt,
    completedAt: detail.completedAt,
  };

  const remove = async () => {
    if (!window.confirm(t("generations.deleteConfirm"))) return;
    const response = await authFetch(
      `/api/bots/${encodeURIComponent(botId)}/generations/${source}/${encodeURIComponent(detail.id)}`,
      { method: "DELETE" },
    );
    if (response.ok) navigate(`/bots/${encodeURIComponent(botId)}/generations`);
  };

  return (
    <div className="mx-auto max-w-6xl space-y-6">
      <Link
        to={`/bots/${encodeURIComponent(botId)}/generations`}
        className="text-muted-foreground hover:text-foreground inline-flex items-center gap-2 text-sm"
      >
        <ArrowLeft className="size-4" />
        {t("generations.backToArchive")}
      </Link>

      <header className="relative overflow-hidden rounded-2xl border bg-slate-950 p-6 text-white shadow-sm sm:p-8">
        <div className="pointer-events-none absolute -top-20 left-1/3 h-48 w-80 rounded-full bg-violet-500/15 blur-3xl" />
        <div className="relative grid gap-6 lg:grid-cols-[1fr_auto] lg:items-end">
          <div className="space-y-4">
            <div className="flex flex-wrap items-center gap-2">
              <Badge variant={detail.legacy ? "muted" : "success"}>
                {detail.legacy ? t("generations.legacyBadge") : t("generations.unifiedBadge")}
              </Badge>
              <Badge variant={detail.statusGroup === "failed" ? "destructive" : "warning"}>
                {detail.state}
              </Badge>
              {ACTIVE_STATES.has(detail.state) && (
                <span className="flex items-center gap-1.5 text-xs text-cyan-200">
                  <Loader2 className="size-3.5 animate-spin" />
                  {t("generations.liveUpdating")}
                </span>
              )}
            </div>
            <div>
              <div className="mb-2 flex items-center gap-2 text-violet-200">
                <Sparkles className="size-4" />
                <span className="text-xs font-semibold tracking-[0.18em] uppercase">
                  {t("generations.generationArchive")}
                </span>
              </div>
              <h1 className="text-2xl font-semibold tracking-tight sm:text-3xl">
                {t("generations.taskDetail")}
              </h1>
              <p className="mt-2 font-mono text-xs break-all text-slate-400">{detail.id}</p>
            </div>
          </div>
          <CopyButton
            value={JSON.stringify(reproduction, null, 2)}
            label={t("generations.copyReproduction")}
          />
        </div>
      </header>

      {images.length > 0 ? (
        <Card className="overflow-hidden">
          <GenerationGallery
            images={images}
            scores={detail.nsfwScores}
            aspectRatio={
              snapshot.width && snapshot.height
                ? `${snapshot.width} / ${snapshot.height}`
                : undefined
            }
          />
        </Card>
      ) : detail.filesPurgedAt ? (
        <Card className="border-amber-200 bg-amber-50/60">
          <CardContent className="flex gap-3 pt-5 text-amber-900 sm:pt-6">
            <FileWarning className="mt-0.5 size-5 shrink-0" />
            <div>
              <p className="font-semibold">{t("generations.originalPurged")}</p>
              <p className="mt-1 text-sm leading-6 text-amber-800">
                {t("generations.metadataRetained")}
              </p>
            </div>
          </CardContent>
        </Card>
      ) : null}

      <div className="grid gap-6 lg:grid-cols-[minmax(0,1.45fr)_minmax(18rem,0.75fr)]">
        <div className="space-y-6">
          <PromptCard
            title={t("generations.prompt")}
            value={detail.prompt}
            copyLabel={t("generations.copyPrompt")}
          />
          <PromptCard
            title={t("generations.negativePrompt")}
            value={detail.negativePrompt || t("generations.notProvided")}
            copyLabel={t("generations.copyNegativePrompt")}
            disabled={!detail.negativePrompt}
          />

          <Card>
            <CardHeader>
              <CardTitle>{t("generations.timeline")}</CardTitle>
              <CardDescription>
                {detail.legacy
                  ? t("generations.legacyTimelineDescription")
                  : t("generations.timelineDescription")}
              </CardDescription>
            </CardHeader>
            <CardContent>
              <ol className="relative ml-2 border-l border-slate-200">
                {detail.events.map((event) => (
                  <li key={event.id} className="relative pb-6 pl-6 last:pb-0">
                    <span className="border-background absolute top-1 -left-[5px] size-2.5 rounded-full border-2 bg-violet-500" />
                    <div className="flex flex-wrap items-baseline justify-between gap-2">
                      <span className="text-sm font-semibold">
                        {t(`generations.event.${event.kind}`, { defaultValue: event.kind })}
                      </span>
                      <time className="text-muted-foreground text-xs tabular-nums">
                        {dateFormatter.format(new Date(event.createdAt))}
                      </time>
                    </div>
                    {(event.state || event.providerState) && (
                      <p className="text-muted-foreground mt-1 font-mono text-xs">
                        {[event.state, event.providerState].filter(Boolean).join(" · ")}
                      </p>
                    )}
                  </li>
                ))}
              </ol>
            </CardContent>
          </Card>
        </div>

        <aside className="space-y-6">
          <Card>
            <CardHeader>
              <CardTitle>{t("generations.parameters")}</CardTitle>
            </CardHeader>
            <CardContent>
              <dl className="grid grid-cols-2 gap-x-4 gap-y-4 text-sm">
                <Parameter label={t("generations.provider")} value={detail.provider} />
                <Parameter label={t("generations.purpose")} value={detail.purpose} />
                <Parameter label={t("generations.preset")} value={detail.presetKey} />
                <Parameter label={t("generations.model")} value={snapshot.modelId} />
                <Parameter
                  label={t("generations.dimensions")}
                  value={
                    snapshot.width && snapshot.height
                      ? `${snapshot.width}×${snapshot.height}`
                      : null
                  }
                />
                <Parameter label={t("generations.batchSize")} value={snapshot.batchSize} />
                <Parameter label={t("generations.steps")} value={snapshot.samplingSteps} />
                <Parameter label={t("generations.cfgScale")} value={snapshot.cfgScale} />
                <Parameter label={t("generations.sampler")} value={snapshot.sampler} />
                <Parameter label={t("generations.seed")} value={detail.seed} />
              </dl>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>{t("generations.milestones")}</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3 text-sm">
              <Milestone
                icon={<Clock3 />}
                label={t("generations.createdAt")}
                value={detail.createdAt}
              />
              <Milestone
                icon={<Check />}
                label={t("generations.completedAt")}
                value={detail.completedAt}
              />
              <Milestone
                icon={<Sparkles />}
                label={t("generations.deliveredAt")}
                value={detail.deliveredAt}
              />
            </CardContent>
          </Card>

          <InlineDisclosure title={t("generations.technicalDetails")}>
            <CodeBlock className="max-h-80 text-[11px] leading-relaxed">
              {JSON.stringify(
                {
                  providerOperationId: detail.providerOperationId,
                  providerState: detail.providerState,
                  approvalState: detail.approvalState,
                  errorCode: detail.errorCode,
                  artifacts: detail.artifacts,
                  technical: detail.technical,
                },
                null,
                2,
              )}
            </CodeBlock>
          </InlineDisclosure>

          <Card className="border-red-200">
            <CardHeader>
              <div className="flex items-center gap-2 text-red-700">
                <ShieldAlert className="size-5" />
                <CardTitle>{t("generations.dangerZone")}</CardTitle>
              </div>
              <CardDescription>
                {canDelete
                  ? t("generations.deleteDescription")
                  : t("generations.cancelBeforeDelete")}
              </CardDescription>
            </CardHeader>
            <CardContent>
              <Button variant="destructive" onClick={remove} disabled={!canDelete}>
                <Trash2 className="size-4" />
                {t("generations.deleteTitle")}
              </Button>
            </CardContent>
          </Card>
        </aside>
      </div>
    </div>
  );
}

function PromptCard({
  title,
  value,
  copyLabel,
  disabled,
}: {
  title: string;
  value: string;
  copyLabel: string;
  disabled?: boolean;
}) {
  return (
    <Card>
      <CardHeader className="flex-row items-center justify-between space-y-0">
        <CardTitle>{title}</CardTitle>
        <CopyButton value={value} label={copyLabel} disabled={disabled} compact />
      </CardHeader>
      <CardContent>
        <pre className="max-h-[32rem] overflow-auto rounded-xl border bg-slate-950 p-4 font-mono text-xs leading-6 break-words whitespace-pre-wrap text-slate-100 sm:text-sm">
          {value}
        </pre>
      </CardContent>
    </Card>
  );
}

function CopyButton({
  value,
  label,
  disabled,
  compact,
}: {
  value: string;
  label: string;
  disabled?: boolean;
  compact?: boolean;
}) {
  const { t } = useTranslation("botData");
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    await navigator.clipboard.writeText(value);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1_500);
  };
  return (
    <Button
      type="button"
      variant={compact ? "ghost" : "outline"}
      size={compact ? "sm" : "default"}
      className={
        compact
          ? undefined
          : "border-white/20 bg-white/10 text-white hover:bg-white/15 hover:text-white"
      }
      onClick={copy}
      disabled={disabled}
    >
      {copied ? (
        <Check className="size-4" />
      ) : compact ? (
        <Copy className="size-4" />
      ) : (
        <Clipboard className="size-4" />
      )}
      {copied ? t("generations.copied") : label}
    </Button>
  );
}

function Parameter({ label, value }: { label: string; value: unknown }) {
  if (value === null || value === undefined || value === "") return null;
  return (
    <div>
      <dt className="text-muted-foreground text-xs">{label}</dt>
      <dd className="mt-1 font-mono text-xs font-semibold break-words">{String(value)}</dd>
    </div>
  );
}

function Milestone({
  icon,
  label,
  value,
}: {
  icon: ReactElement;
  label: string;
  value: string | null;
}) {
  const { i18n } = useTranslation();
  if (!value) return null;
  return (
    <div className="flex gap-3">
      <span className="text-muted-foreground [&>svg]:size-4">{icon}</span>
      <div>
        <div className="text-muted-foreground text-xs">{label}</div>
        <div className="mt-0.5 text-xs tabular-nums">
          {new Intl.DateTimeFormat(i18n.resolvedLanguage ?? i18n.language, {
            dateStyle: "medium",
            timeStyle: "short",
          }).format(new Date(value))}
        </div>
      </div>
    </div>
  );
}
