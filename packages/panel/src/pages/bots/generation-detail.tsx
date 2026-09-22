import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { CodeBlock } from "@/components/ui/code-block";
import { InlineDisclosure } from "@/components/ui/inline-disclosure";
import { authFetch } from "@/lib/client";
import {
  AlertTriangle,
  ArrowLeft,
  Check,
  Clipboard,
  Clock3,
  Copy,
  FileWarning,
  Loader2,
  RefreshCw,
  ShieldAlert,
  Sparkles,
  Trash2,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactElement } from "react";
import { useTranslation } from "react-i18next";
import { Link, useNavigate, useParams } from "react-router";
import { GenerationDeleteNotice, type GenerationNoticeKind } from "./generation-delete-notice";
import { GenerationGallery } from "./generation-gallery";
import {
  deleteGeneration,
  type GenerationTarget,
  requireGenerationRead,
  useGenerationResource,
  verifyGenerationTarget,
} from "./generation-resource";
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
  if (!botId || !generationId || (source !== "unified" && source !== "legacy")) {
    return (
      <div className="text-muted-foreground py-16 text-center">{t("generations.notFound")}</div>
    );
  }
  const scopeKey = `${botId}:${source}:${generationId}`;
  return (
    <BotGenerationDetailContent
      key={scopeKey}
      botId={botId}
      source={source}
      generationId={generationId}
      locale={i18n.resolvedLanguage ?? i18n.language}
    />
  );
}

function isGenerationDetailResponse(body: unknown): body is GenerationDetailResponse {
  if (!body || typeof body !== "object") return false;
  const value = body as Partial<GenerationDetailResponse>;
  const data = value.data;
  const validDate = (candidate: unknown) =>
    typeof candidate === "string" && !Number.isNaN(Date.parse(candidate));
  const nullableString = (candidate: unknown) =>
    candidate === null || typeof candidate === "string";
  const nullableDate = (candidate: unknown) => candidate === null || validDate(candidate);
  const validScores = (candidate: unknown) =>
    candidate === null ||
    (Array.isArray(candidate) &&
      candidate.every(
        (score) =>
          !!score &&
          typeof score === "object" &&
          ["porn", "hentai", "sexy"].every(
            (key) => typeof (score as Record<string, unknown>)[key] === "number",
          ),
      ));
  return (
    value.ok === true &&
    !!data &&
    typeof data === "object" &&
    (data.source === "unified" || data.source === "legacy") &&
    (typeof data.id === "string" || typeof data.id === "number") &&
    typeof data.legacy === "boolean" &&
    typeof data.provider === "string" &&
    typeof data.prompt === "string" &&
    nullableString(data.negativePrompt) &&
    typeof data.purpose === "string" &&
    typeof data.state === "string" &&
    ["active", "succeeded", "failed", "cancelled", "attention"].includes(
      String(data.statusGroup),
    ) &&
    Array.isArray(data.localFiles) &&
    data.localFiles.every((file) => typeof file === "string") &&
    validDate(data.createdAt) &&
    nullableDate(data.completedAt) &&
    nullableDate(data.deliveredAt) &&
    (data.requestSnapshot === null ||
      (!!data.requestSnapshot && typeof data.requestSnapshot === "object")) &&
    validScores(data.nsfwScores) &&
    Array.isArray(data.artifacts) &&
    !!data.technical &&
    typeof data.technical === "object" &&
    Array.isArray(data.events) &&
    data.events.every(
      (event) =>
        !!event &&
        typeof event === "object" &&
        (typeof event.id === "string" || typeof event.id === "number") &&
        typeof event.kind === "string" &&
        nullableString(event.state) &&
        nullableString(event.providerState) &&
        validDate(event.createdAt),
    )
  );
}

function BotGenerationDetailContent({
  botId,
  source,
  generationId,
  locale,
}: {
  botId: string;
  source: GenerationSource;
  generationId: string;
  locale: string;
}) {
  const { t } = useTranslation("botData");
  const navigate = useNavigate();
  const [deleteBusy, setDeleteBusy] = useState(false);
  const [recovering, setRecovering] = useState(false);
  const [deleteNotice, setDeleteNotice] = useState<{
    kind: GenerationNoticeKind;
    target: GenerationTarget;
  } | null>(null);
  const mountedRef = useRef(false);
  const mutationRef = useRef(false);
  const recoveryTargetRef = useRef<GenerationTarget | null>(null);
  const recoveryControllerRef = useRef<AbortController | null>(null);
  const deleteNoticeRef = useRef<HTMLDivElement>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const focusAfterReadRef = useRef(false);
  const dateFormatter = useMemo(
    () => new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "medium" }),
    [locale],
  );

  const requestDetail = useCallback(
    async (signal: AbortSignal) => {
      const response = await authFetch(
        `/api/bots/${encodeURIComponent(botId)}/generations/${source}/${encodeURIComponent(generationId)}`,
        { signal },
      );
      const result = await requireGenerationRead<GenerationDetailResponse>(response, {
        notFound: true,
        validate: isGenerationDetailResponse,
      });
      if (String(result.data.id) !== generationId || result.data.source !== source) {
        throw new Error("Generation detail scope mismatch");
      }
      return result.data;
    },
    [botId, generationId, source],
  );
  const detailResource = useGenerationResource<GenerationDetail>(
    JSON.stringify([botId, source, generationId]),
    requestDetail,
  );
  const detail = detailResource.result;
  const operationBusy = deleteBusy || recovering;
  const writesLocked =
    operationBusy ||
    deleteNotice?.kind === "unknown" ||
    deleteNotice?.kind === "active" ||
    deleteNotice?.kind === "bot-missing";

  const refreshDetail = detailResource.refresh;
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      recoveryControllerRef.current?.abort();
    };
  }, []);
  useEffect(() => {
    if (!deleteNotice) return;
    requestAnimationFrame(() => {
      deleteNoticeRef.current?.scrollIntoView({ block: "nearest" });
      deleteNoticeRef.current?.focus();
    });
  }, [deleteNotice]);
  useEffect(() => {
    if (
      !focusAfterReadRef.current ||
      !detailResource.result ||
      detailResource.loading ||
      detailResource.failure
    )
      return;
    focusAfterReadRef.current = false;
    requestAnimationFrame(() => {
      headingRef.current?.scrollIntoView({ block: "start" });
      headingRef.current?.focus();
    });
  }, [detailResource.failure, detailResource.loading, detailResource.result]);
  useEffect(() => {
    if (!detail || !ACTIVE_STATES.has(detail.state)) return;
    let pollPending = false;
    const timer = window.setInterval(() => {
      if (pollPending || mutationRef.current) return;
      pollPending = true;
      void refreshDetail().finally(() => {
        pollPending = false;
      });
    }, 4_000);
    return () => window.clearInterval(timer);
  }, [detail, refreshDetail]);

  if (!detail && detailResource.loading) {
    return (
      <div className="text-muted-foreground flex items-center justify-center gap-2 py-20 text-sm">
        <Loader2 className="size-4 animate-spin" />
        {t("common.loading")}
      </div>
    );
  }
  if (!detail && detailResource.failure === "not-found") {
    return (
      <div className="text-muted-foreground py-16 text-center">{t("generations.notFound")}</div>
    );
  }
  if (!detail) {
    return (
      <div
        className="mx-auto flex max-w-xl flex-col items-center gap-4 py-16 text-center"
        role="alert"
      >
        <AlertTriangle className="size-8 text-red-600" aria-hidden="true" />
        <p className="text-sm text-red-700">{t("generations.detailLoadFailed")}</p>
        <Button
          onClick={() => {
            focusAfterReadRef.current = true;
            void detailResource.refresh();
          }}
        >
          <RefreshCw className="size-4" aria-hidden="true" />
          {t("common.retry")}
        </Button>
      </div>
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

  const recoverDeletion = async () => {
    const target = recoveryTargetRef.current;
    if (!target || mutationRef.current) return;
    mutationRef.current = true;
    setRecovering(true);
    const controller = new AbortController();
    recoveryControllerRef.current?.abort();
    recoveryControllerRef.current = controller;
    try {
      const targetState = await verifyGenerationTarget(target, controller.signal);
      if (!mountedRef.current || controller.signal.aborted) return;
      if (targetState === "missing") {
        recoveryTargetRef.current = null;
        navigate(`/bots/${encodeURIComponent(botId)}/generations`);
      } else if (targetState === "present") {
        focusAfterReadRef.current = true;
        const refreshed = await detailResource.refresh();
        if (!mountedRef.current) return;
        if (refreshed) {
          recoveryTargetRef.current = null;
          setDeleteNotice(null);
        }
      } else if (targetState === "bot-missing") {
        setDeleteNotice({ kind: "bot-missing", target });
      }
    } finally {
      mutationRef.current = false;
      if (mountedRef.current) setRecovering(false);
    }
  };

  const remove = async () => {
    if (mutationRef.current || writesLocked || !window.confirm(t("generations.deleteConfirm")))
      return;
    const target: GenerationTarget = { botId, source, id: String(detail.id) };
    mutationRef.current = true;
    recoveryTargetRef.current = target;
    setDeleteBusy(true);
    setDeleteNotice(null);
    try {
      const result = await deleteGeneration(target);
      if (!mountedRef.current) return;
      if (result === "deleted") {
        recoveryTargetRef.current = null;
        navigate(`/bots/${encodeURIComponent(botId)}/generations`);
      } else {
        setDeleteNotice({ kind: result === "active" ? "active" : "unknown", target });
      }
    } finally {
      mutationRef.current = false;
      if (mountedRef.current) setDeleteBusy(false);
    }
  };

  return (
    <div className="mx-auto max-w-6xl space-y-6">
      <Link
        to={`/bots/${encodeURIComponent(botId)}/generations`}
        className="text-muted-foreground hover:text-foreground inline-flex items-center gap-2 text-sm"
        aria-disabled={operationBusy}
        tabIndex={operationBusy ? -1 : undefined}
        onClick={(event) => {
          if (operationBusy) event.preventDefault();
        }}
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
              <h1
                ref={headingRef}
                tabIndex={-1}
                className="text-2xl font-semibold tracking-tight outline-none sm:text-3xl"
              >
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

      {detailResource.failure ? (
        <div
          className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800"
          role="alert"
        >
          <span className="flex items-center gap-2">
            <AlertTriangle className="size-4 shrink-0" aria-hidden="true" />
            {t("common.refreshFailed")}
          </span>
          <Button
            variant="outline"
            size="sm"
            disabled={operationBusy || detailResource.loading}
            onClick={() => {
              if (recoveryTargetRef.current) {
                void recoverDeletion();
              } else {
                focusAfterReadRef.current = true;
                void detailResource.refresh();
              }
            }}
          >
            <RefreshCw className="size-4" aria-hidden="true" />
            {t("common.retry")}
          </Button>
        </div>
      ) : null}

      {detailResource.loading ? (
        <p className="text-muted-foreground flex items-center gap-2 text-sm" role="status">
          <Loader2 className="size-4 animate-spin" aria-hidden="true" />
          {t("generations.refreshing")}
        </p>
      ) : null}

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

          {deleteNotice ? (
            <div ref={deleteNoticeRef} tabIndex={-1} className="outline-none">
              <GenerationDeleteNotice
                kind={deleteNotice.kind}
                busy={recovering}
                onRecover={() => void recoverDeletion()}
              />
            </div>
          ) : null}

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
              <Button
                variant="destructive"
                onClick={remove}
                disabled={!canDelete || writesLocked || !!detailResource.failure}
                aria-label={t("generations.deleteTitle")}
              >
                {deleteBusy ? (
                  <Loader2 className="size-4 animate-spin" />
                ) : (
                  <Trash2 className="size-4" />
                )}
                {t(deleteBusy ? "generations.deleting" : "generations.deleteTitle")}
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
