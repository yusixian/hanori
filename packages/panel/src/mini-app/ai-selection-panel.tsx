import {
  AlertTriangle,
  CheckCircle2,
  Clock3,
  Eye,
  EyeOff,
  RefreshCw,
  RotateCcw,
  Save,
  Sparkles,
} from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  fetchChatAiSelection,
  fetchGlobalAiSelection,
  MiniAppAiSelectionApiError,
  patchChatAiSelection,
  patchChatAiSelectionDisplay,
  patchGlobalAiSelection,
  resetChatAiSelection,
  retryAiSelection,
  type AdminChatAiSelectionView,
  type AiSelectionDisplayPolicy,
  type AiSelectionOptionProvider,
  type GlobalAiSelectionView,
  type PublicChatAiSelectionView,
} from "./ai-selection";
import type { MiniAppSessionView } from "./session";

type Feedback = { kind: "success" | "pending" | "error"; key: string } | null;

interface SelectionDraft {
  providerId: string;
  modelId: string;
}

interface GlobalDraft extends SelectionDraft {
  displayDefault: "show" | "hide";
}

interface ChatDraft extends SelectionDraft {
  displayPolicy: AiSelectionDisplayPolicy;
}

function draftModel(
  providerId: string,
  modelId: string | null,
  options: readonly AiSelectionOptionProvider[],
): string {
  const provider = options.find((candidate) => candidate.id === providerId);
  return modelId ?? provider?.defaultModelId ?? "";
}

function globalDraft(view: GlobalAiSelectionView): GlobalDraft {
  return {
    providerId: view.selection.providerId,
    modelId: draftModel(view.selection.providerId, view.selection.modelId, view.options),
    displayDefault: view.displayDefault,
  };
}

function chatDraft(view: AdminChatAiSelectionView): ChatDraft {
  return {
    providerId: view.selection.providerId,
    modelId: draftModel(view.selection.providerId, view.selection.modelId, view.options),
    displayPolicy: view.display.overridePolicy,
  };
}

function selectedProvider(
  options: readonly AiSelectionOptionProvider[],
  providerId: string,
): AiSelectionOptionProvider | undefined {
  return options.find((provider) => provider.id === providerId);
}

function FeedbackLine({ feedback }: { feedback: Feedback }) {
  const { t } = useTranslation("miniApp");
  if (!feedback) return null;
  return (
    <p
      className={`mini-ai-feedback is-${feedback.kind}`}
      role={feedback.kind === "error" ? "alert" : "status"}
    >
      {feedback.kind === "error" ? (
        <AlertTriangle aria-hidden="true" />
      ) : feedback.kind === "pending" ? (
        <Clock3 aria-hidden="true" />
      ) : (
        <CheckCircle2 aria-hidden="true" />
      )}
      {t(feedback.key)}
    </p>
  );
}

function SelectionFields({
  options,
  draft,
  disabled,
  onChange,
}: {
  options: readonly AiSelectionOptionProvider[];
  draft: SelectionDraft;
  disabled: boolean;
  onChange: (draft: SelectionDraft) => void;
}) {
  const { t } = useTranslation("miniApp");
  const provider = selectedProvider(options, draft.providerId);
  return (
    <div className="mini-ai-fields">
      <label>
        <span>{t("aiSelection.fields.provider")}</span>
        <select
          aria-label={t("aiSelection.fields.provider")}
          value={draft.providerId}
          disabled={disabled}
          onChange={(event) => {
            const next = selectedProvider(options, event.target.value);
            if (next) onChange({ providerId: next.id, modelId: next.defaultModelId });
          }}
        >
          {options.map((option) => (
            <option key={option.id} value={option.id}>
              {option.label}
            </option>
          ))}
        </select>
      </label>
      <label>
        <span>{t("aiSelection.fields.model")}</span>
        <select
          aria-label={t("aiSelection.fields.model")}
          value={draft.modelId}
          disabled={disabled || !provider}
          onChange={(event) => onChange({ ...draft, modelId: event.target.value })}
        >
          {provider?.models.map((model) => (
            <option key={model.id} value={model.id}>
              {model.label}
            </option>
          ))}
        </select>
      </label>
    </div>
  );
}

function PendingBanner({
  retrying,
  disabled,
  onRetry,
}: {
  retrying: boolean;
  disabled?: boolean;
  onRetry: () => void;
}) {
  const { t } = useTranslation("miniApp");
  return (
    <div className="mini-ai-pending" role="status">
      <div>
        <Clock3 aria-hidden="true" />
        <span>
          <strong>{t("aiSelection.pendingTitle")}</strong>
          {t("aiSelection.pendingBody")}
        </span>
      </div>
      <button type="button" disabled={retrying || disabled} onClick={onRetry}>
        <RefreshCw aria-hidden="true" />
        {t(retrying ? "aiSelection.retrying" : "aiSelection.retry")}
      </button>
    </div>
  );
}

function ConflictNotice({ onAdopt }: { onAdopt: () => void }) {
  const { t } = useTranslation("miniApp");
  return (
    <div className="mini-ai-conflict" role="alert">
      <AlertTriangle aria-hidden="true" />
      <span>
        <strong>{t("aiSelection.conflictTitle")}</strong>
        {t("aiSelection.conflictBody")}
      </span>
      <button type="button" onClick={onAdopt}>
        {t("aiSelection.useLatest")}
      </button>
    </div>
  );
}

export function GlobalAiSelectionSettings({
  botId,
  session,
}: {
  botId: string;
  session: MiniAppSessionView;
}) {
  const { t } = useTranslation("miniApp");
  const [view, setView] = useState<GlobalAiSelectionView | null>(null);
  const [draft, setDraft] = useState<GlobalDraft | null>(null);
  const [failed, setFailed] = useState(false);
  const [saving, setSaving] = useState(false);
  const [retrying, setRetrying] = useState(false);
  const [feedback, setFeedback] = useState<Feedback>(null);
  const [conflictLatest, setConflictLatest] = useState<GlobalAiSelectionView | null>(null);

  const adopt = useCallback((next: GlobalAiSelectionView) => {
    setView(next);
    setDraft(globalDraft(next));
  }, []);

  const load = useCallback(async () => {
    setFailed(false);
    try {
      adopt(await fetchGlobalAiSelection(botId));
    } catch {
      setFailed(true);
    }
  }, [adopt, botId]);

  useEffect(() => {
    let active = true;
    void fetchGlobalAiSelection(botId)
      .then((next) => {
        if (active) adopt(next);
      })
      .catch(() => {
        if (active) setFailed(true);
      });
    return () => {
      active = false;
    };
  }, [adopt, botId]);

  const changed = Boolean(
    view &&
    draft &&
    (draft.providerId !== view.selection.providerId ||
      draft.modelId !==
        draftModel(view.selection.providerId, view.selection.modelId, view.options) ||
      draft.displayDefault !== view.displayDefault),
  );

  const save = async () => {
    if (!view || !draft || !changed) return;
    setSaving(true);
    setFeedback(null);
    setConflictLatest(null);
    try {
      const result = await patchGlobalAiSelection({
        botId,
        expectedRevision: view.revision,
        providerId: draft.providerId,
        modelId: draft.modelId,
        displayDefault: draft.displayDefault,
        csrfToken: session.csrfToken,
      });
      adopt(result.global);
      setFeedback({
        kind: result.applied ? "success" : "pending",
        key: result.applied ? "aiSelection.saved" : "aiSelection.savedPending",
      });
    } catch (error) {
      if (
        error instanceof MiniAppAiSelectionApiError &&
        error.code === "stale_revision" &&
        error.latest &&
        "displayDefault" in error.latest
      ) {
        setConflictLatest(error.latest);
        setFeedback(null);
      } else {
        setFeedback({ kind: "error", key: "aiSelection.saveFailed" });
      }
    } finally {
      setSaving(false);
    }
  };

  const retry = async () => {
    setRetrying(true);
    setFeedback(null);
    try {
      const result = await retryAiSelection({ botId, csrfToken: session.csrfToken });
      setView((current) => (current ? { ...current, applyState: result.applyState } : current));
      setFeedback({
        kind: result.applied ? "success" : "pending",
        key: result.applied ? "aiSelection.retryApplied" : "aiSelection.retryPending",
      });
    } catch {
      setFeedback({ kind: "error", key: "aiSelection.retryFailed" });
    } finally {
      setRetrying(false);
    }
  };

  if (!view || !draft) {
    return (
      <section className="mini-ai-settings mini-groups-state">
        {failed ? (
          <>
            <AlertTriangle aria-hidden="true" />
            <h1>{t("aiSelection.unavailableTitle")}</h1>
            <p>{t("aiSelection.unavailableBody")}</p>
            <button type="button" onClick={() => void load()}>
              <RefreshCw aria-hidden="true" />
              {t("aiSelection.tryAgain")}
            </button>
          </>
        ) : (
          <>
            <span className="mini-app-loader" />
            <p>{t("aiSelection.loadingGlobal")}</p>
          </>
        )}
      </section>
    );
  }

  return (
    <section className="mini-ai-settings mini-ai-global-section">
      {view.applyState === "pending" ? (
        <PendingBanner retrying={retrying} disabled={changed} onRetry={() => void retry()} />
      ) : null}

      <section className="mini-ai-card mini-ai-global-card">
        <div className="mini-ai-card-heading">
          <Sparkles aria-hidden="true" />
          <div>
            <p>{t("aiSelection.globalEyebrow")}</p>
            <h2>{t("aiSelection.globalTitle")}</h2>
          </div>
        </div>
        <SelectionFields
          options={view.options}
          draft={draft}
          disabled={saving}
          onChange={(selection) =>
            setDraft((current) => (current ? { ...current, ...selection } : current))
          }
        />
        <label className="mini-ai-select-row mini-ai-display-row">
          <span>
            {draft.displayDefault === "show" ? (
              <Eye aria-hidden="true" />
            ) : (
              <EyeOff aria-hidden="true" />
            )}
            {t("aiSelection.fields.defaultDisplay")}
          </span>
          <select
            aria-label={t("aiSelection.fields.defaultDisplay")}
            value={draft.displayDefault}
            disabled={saving}
            onChange={(event) =>
              setDraft((current) =>
                current
                  ? { ...current, displayDefault: event.target.value as "show" | "hide" }
                  : current,
              )
            }
          >
            <option value="show">{t("aiSelection.display.show")}</option>
            <option value="hide">{t("aiSelection.display.hide")}</option>
          </select>
        </label>

        <div className="mini-ai-actions">
          <button
            type="button"
            className="is-secondary"
            disabled={!changed || saving}
            onClick={() => {
              setDraft(globalDraft(view));
              setFeedback(null);
              setConflictLatest(null);
            }}
          >
            {t("aiSelection.discard")}
          </button>
          <button type="button" disabled={!changed || saving} onClick={() => void save()}>
            <Save aria-hidden="true" />
            {t(saving ? "aiSelection.saving" : "aiSelection.save")}
          </button>
        </div>
      </section>

      <FeedbackLine feedback={feedback} />
      {conflictLatest ? (
        <ConflictNotice
          onAdopt={() => {
            adopt(conflictLatest);
            setConflictLatest(null);
            setFeedback(null);
          }}
        />
      ) : null}
    </section>
  );
}

export function GroupAiSelectionCard({
  botId,
  chatId,
  session,
}: {
  botId: string;
  chatId: number;
  session: MiniAppSessionView;
}) {
  const { t } = useTranslation("miniApp");
  const admin = session.role === "admin";
  const [view, setView] = useState<AdminChatAiSelectionView | PublicChatAiSelectionView | null>(
    null,
  );
  const [draft, setDraft] = useState<ChatDraft | null>(null);
  const [failed, setFailed] = useState(false);
  const [saving, setSaving] = useState(false);
  const [retrying, setRetrying] = useState(false);
  const [feedback, setFeedback] = useState<Feedback>(null);
  const [conflictLatest, setConflictLatest] = useState<AdminChatAiSelectionView | null>(null);

  const adopt = useCallback((next: AdminChatAiSelectionView | PublicChatAiSelectionView) => {
    setView(next);
    setDraft("options" in next ? chatDraft(next) : null);
  }, []);

  const load = useCallback(async () => {
    setFailed(false);
    try {
      adopt(await fetchChatAiSelection({ botId, chatId, admin }));
    } catch {
      setFailed(true);
    }
  }, [admin, adopt, botId, chatId]);

  useEffect(() => {
    let active = true;
    void fetchChatAiSelection({ botId, chatId, admin })
      .then((next) => {
        if (active) adopt(next);
      })
      .catch(() => {
        if (active) setFailed(true);
      });
    return () => {
      active = false;
    };
  }, [admin, adopt, botId, chatId]);

  const selectionChanged = Boolean(
    view &&
    "options" in view &&
    draft &&
    (draft.providerId !== view.selection.providerId ||
      draft.modelId !==
        draftModel(view.selection.providerId, view.selection.modelId, view.options)),
  );
  const displayChanged = Boolean(
    view && "display" in view && draft && draft.displayPolicy !== view.display.overridePolicy,
  );

  const save = async () => {
    if (!view || !("options" in view) || !draft || (!selectionChanged && !displayChanged)) return;
    setSaving(true);
    setFeedback(null);
    setConflictLatest(null);
    try {
      let current = view;
      let applied = true;
      if (selectionChanged) {
        const result = await patchChatAiSelection({
          botId,
          chatId,
          expectedRevision: current.revision,
          providerId: draft.providerId,
          modelId: draft.modelId,
          csrfToken: session.csrfToken,
        });
        current = result.chat;
        applied &&= result.applied;
      }
      if (displayChanged) {
        const result = await patchChatAiSelectionDisplay({
          botId,
          chatId,
          expectedRevision: current.revision,
          policy: draft.displayPolicy,
          csrfToken: session.csrfToken,
        });
        current = result.chat;
        applied &&= result.applied;
      }
      adopt(current);
      setFeedback({
        kind: applied ? "success" : "pending",
        key: applied ? "aiSelection.saved" : "aiSelection.savedPending",
      });
    } catch (error) {
      if (
        error instanceof MiniAppAiSelectionApiError &&
        error.code === "stale_revision" &&
        error.latest &&
        "display" in error.latest
      ) {
        setConflictLatest(error.latest);
        setFeedback(null);
      } else {
        setFeedback({ kind: "error", key: "aiSelection.saveFailed" });
      }
    } finally {
      setSaving(false);
    }
  };

  const reset = async () => {
    if (!view || !("options" in view)) return;
    setSaving(true);
    setFeedback(null);
    try {
      const result = await resetChatAiSelection({
        botId,
        chatId,
        expectedRevision: view.revision,
        csrfToken: session.csrfToken,
      });
      adopt(result.chat);
      setFeedback({
        kind: result.applied ? "success" : "pending",
        key: result.applied ? "aiSelection.resetDone" : "aiSelection.savedPending",
      });
    } catch (error) {
      if (
        error instanceof MiniAppAiSelectionApiError &&
        error.code === "stale_revision" &&
        error.latest &&
        "display" in error.latest
      ) {
        setConflictLatest(error.latest);
        setFeedback(null);
      } else {
        setFeedback({ kind: "error", key: "aiSelection.saveFailed" });
      }
    } finally {
      setSaving(false);
    }
  };

  const retry = async () => {
    setRetrying(true);
    setFeedback(null);
    try {
      const result = await retryAiSelection({ botId, csrfToken: session.csrfToken });
      setView((current) => (current ? { ...current, applyState: result.applyState } : current));
      setFeedback({
        kind: result.applied ? "success" : "pending",
        key: result.applied ? "aiSelection.retryApplied" : "aiSelection.retryPending",
      });
    } catch {
      setFeedback({ kind: "error", key: "aiSelection.retryFailed" });
    } finally {
      setRetrying(false);
    }
  };

  if (!admin) {
    if (!view || !("selection" in view) || !view.selection) return null;
    return (
      <section
        className="mini-ai-card mini-ai-readonly"
        aria-label={t("aiSelection.selectionTitle")}
      >
        <div className="mini-ai-card-heading">
          <Sparkles aria-hidden="true" />
          <div>
            <h2>{t("aiSelection.selectionTitle")}</h2>
            <p>{t("aiSelection.safeLabelsOnly")}</p>
          </div>
        </div>
        <dl>
          <div>
            <dt>{t("aiSelection.fields.provider")}</dt>
            <dd>{view.selection.providerLabel}</dd>
          </div>
          <div>
            <dt>{t("aiSelection.fields.model")}</dt>
            <dd>{view.selection.modelLabel}</dd>
          </div>
        </dl>
      </section>
    );
  }

  if (!view || !("options" in view) || !draft) {
    if (!failed) {
      return (
        <section className="mini-ai-card mini-ai-inline-state" role="status">
          <span className="mini-app-loader" />
          {t("aiSelection.loadingChat")}
        </section>
      );
    }
    return (
      <section className="mini-ai-card mini-ai-inline-state" role="alert">
        <AlertTriangle aria-hidden="true" />
        <span>{t("aiSelection.unavailableBody")}</span>
        <button type="button" onClick={() => void load()}>
          <RefreshCw aria-hidden="true" />
          {t("aiSelection.tryAgain")}
        </button>
      </section>
    );
  }

  return (
    <section
      className="mini-ai-card mini-ai-group-card"
      aria-label={t("aiSelection.selectionTitle")}
    >
      <div className="mini-ai-card-heading">
        <Sparkles aria-hidden="true" />
        <div>
          <h2>{t("aiSelection.selectionTitle")}</h2>
          <p>
            {t(`aiSelection.source.${view.source}`)} · {view.selection.providerLabel} /{" "}
            {view.selection.modelLabel}
          </p>
        </div>
      </div>

      {view.applyState === "pending" ? (
        <PendingBanner
          retrying={retrying}
          disabled={selectionChanged || displayChanged}
          onRetry={() => void retry()}
        />
      ) : null}

      <SelectionFields
        options={view.options}
        draft={draft}
        disabled={saving || view.archived}
        onChange={(selection) =>
          setDraft((current) => (current ? { ...current, ...selection } : current))
        }
      />

      <label className="mini-ai-select-row">
        <span>{t("aiSelection.fields.groupDisplay")}</span>
        <select
          aria-label={t("aiSelection.fields.groupDisplay")}
          value={draft.displayPolicy}
          disabled={saving || view.archived}
          onChange={(event) =>
            setDraft((current) =>
              current
                ? { ...current, displayPolicy: event.target.value as AiSelectionDisplayPolicy }
                : current,
            )
          }
        >
          <option value="inherit">
            {t("aiSelection.display.inherit", {
              default: t(`aiSelection.display.${view.display.defaultPolicy}`),
            })}
          </option>
          <option value="show">{t("aiSelection.display.show")}</option>
          <option value="hide">{t("aiSelection.display.hide")}</option>
        </select>
      </label>

      <div className="mini-ai-actions">
        <button
          type="button"
          className="is-secondary"
          disabled={saving || view.archived || view.source === "global"}
          onClick={() => void reset()}
        >
          <RotateCcw aria-hidden="true" />
          {t("aiSelection.resetToGlobal")}
        </button>
        <button
          type="button"
          disabled={saving || view.archived || (!selectionChanged && !displayChanged)}
          onClick={() => void save()}
        >
          <Save aria-hidden="true" />
          {t(saving ? "aiSelection.saving" : "aiSelection.save")}
        </button>
      </div>

      <FeedbackLine feedback={feedback} />
      {conflictLatest ? (
        <ConflictNotice
          onAdopt={() => {
            adopt(conflictLatest);
            setConflictLatest(null);
            setFeedback(null);
          }}
        />
      ) : null}
    </section>
  );
}
