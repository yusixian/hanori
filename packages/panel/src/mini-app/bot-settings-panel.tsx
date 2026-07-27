import {
  AlertTriangle,
  CheckCircle2,
  Clock3,
  Power,
  RefreshCw,
  RotateCw,
  Save,
  SlidersHorizontal,
} from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { GlobalAiSelectionSettings } from "./ai-selection-panel";
import {
  fetchBotLifecycle,
  fetchBotSettings,
  MiniAppBotSettingsApiError,
  mutateBotLifecycle,
  patchBotSettings,
  type BotLifecycleView,
  type BotSettingsView,
  type LifecycleAction,
} from "./bot-settings";
import type { MiniAppSessionView } from "./session";

type Feedback = { kind: "success" | "pending" | "error"; key: string } | null;

function FeedbackLine({ feedback }: { feedback: Feedback }) {
  const { t } = useTranslation("miniApp");
  if (!feedback) return null;
  return (
    <p className={`mini-settings-feedback is-${feedback.kind}`} role="status">
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

function LifecycleCard({
  botId,
  csrfToken,
  lifecycle,
  onChange,
}: {
  botId: string;
  csrfToken: string;
  lifecycle: BotLifecycleView;
  onChange: (next: BotLifecycleView) => void;
}) {
  const { t } = useTranslation("miniApp");
  const [busy, setBusy] = useState<LifecycleAction | null>(null);
  const [feedback, setFeedback] = useState<Feedback>(null);

  const run = async (action: LifecycleAction) => {
    if (
      (action === "disable" || action === "restart") &&
      !window.confirm(t(`botSettings.lifecycle.confirm.${action}`))
    ) {
      return;
    }
    setBusy(action);
    setFeedback(null);
    try {
      const next = await mutateBotLifecycle({ botId, action, csrfToken });
      onChange(next);
      setFeedback({
        kind: next.reconciled && next.applied !== false ? "success" : "pending",
        key:
          next.reconciled && next.applied !== false
            ? `botSettings.lifecycle.feedback.${action}`
            : "botSettings.lifecycle.feedback.pending",
      });
    } catch {
      setFeedback({ kind: "error", key: "botSettings.lifecycle.feedback.failed" });
    } finally {
      setBusy(null);
    }
  };

  return (
    <section className="mini-ai-card mini-settings-lifecycle">
      <div className="mini-ai-card-heading">
        <Power aria-hidden="true" />
        <div>
          <h2>{t("botSettings.lifecycle.title")}</h2>
        </div>
      </div>
      <dl className="mini-settings-state">
        <div>
          <dt>{t("botSettings.lifecycle.desired")}</dt>
          <dd>{t(`botSettings.values.${lifecycle.desiredActive ? "enabled" : "disabled"}`)}</dd>
        </div>
        <div>
          <dt>{t("botSettings.lifecycle.runtime")}</dt>
          <dd>{t(`botSettings.runtime.${lifecycle.runtimeStatus}`)}</dd>
        </div>
        <div>
          <dt>{t("botSettings.lifecycle.reconciliation")}</dt>
          <dd className={lifecycle.reconciled ? "is-good" : "is-pending"}>
            {t(`botSettings.values.${lifecycle.reconciled ? "reconciled" : "pending"}`)}
          </dd>
        </div>
      </dl>
      {!lifecycle.reconciled ? (
        <p className="mini-settings-notice">
          <Clock3 aria-hidden="true" />
          {t("botSettings.lifecycle.unreconciled")}
        </p>
      ) : null}
      <div className="mini-settings-lifecycle-actions">
        {!lifecycle.desiredActive ? (
          <button type="button" disabled={busy !== null} onClick={() => void run("enable")}>
            <Power aria-hidden="true" />
            {t(
              busy === "enable" ? "botSettings.lifecycle.enabling" : "botSettings.lifecycle.enable",
            )}
          </button>
        ) : (
          <button
            type="button"
            className="is-danger"
            disabled={busy !== null}
            onClick={() => void run("disable")}
          >
            <Power aria-hidden="true" />
            {t(
              busy === "disable"
                ? "botSettings.lifecycle.disabling"
                : "botSettings.lifecycle.disable",
            )}
          </button>
        )}
        <button
          type="button"
          className="is-secondary"
          disabled={busy !== null || !lifecycle.desiredActive}
          onClick={() => void run("restart")}
        >
          <RotateCw aria-hidden="true" />
          {t(
            busy === "restart"
              ? "botSettings.lifecycle.restarting"
              : "botSettings.lifecycle.restart",
          )}
        </button>
      </div>
      <FeedbackLine feedback={feedback} />
    </section>
  );
}

function CommonSettingsCard({
  botId,
  csrfToken,
  settings,
  onChange,
}: {
  botId: string;
  csrfToken: string;
  settings: BotSettingsView;
  onChange: (next: BotSettingsView) => void;
}) {
  const { t } = useTranslation("miniApp");
  const [enabled, setEnabled] = useState(settings.ai.enabled);
  const [systemPrompt, setSystemPrompt] = useState(settings.ai.systemPrompt);
  const [saving, setSaving] = useState(false);
  const [feedback, setFeedback] = useState<Feedback>(null);
  const [latest, setLatest] = useState<BotSettingsView | null>(null);
  const changed = enabled !== settings.ai.enabled || systemPrompt !== settings.ai.systemPrompt;

  const adopt = (next: BotSettingsView) => {
    onChange(next);
    setEnabled(next.ai.enabled);
    setSystemPrompt(next.ai.systemPrompt);
    setLatest(null);
    setFeedback(null);
  };

  const save = async () => {
    if (!changed || systemPrompt.length > 50_000) return;
    setSaving(true);
    setFeedback(null);
    setLatest(null);
    try {
      const result = await patchBotSettings({
        botId,
        expectedRevision: settings.revision,
        patch: { enabled, systemPrompt },
        csrfToken,
      });
      adopt(result.settings);
      setFeedback({
        kind: result.applied ? "success" : "pending",
        key: result.applied ? "botSettings.common.saved" : "botSettings.common.savedPending",
      });
    } catch (error) {
      if (error instanceof MiniAppBotSettingsApiError && error.code === "stale_revision") {
        setLatest(error.latest ?? null);
        setFeedback(null);
      } else {
        setFeedback({ kind: "error", key: "botSettings.common.failed" });
      }
    } finally {
      setSaving(false);
    }
  };

  return (
    <section className="mini-ai-card mini-settings-common">
      <div className="mini-ai-card-heading">
        <SlidersHorizontal aria-hidden="true" />
        <div>
          <h2>{t("botSettings.common.title")}</h2>
        </div>
      </div>
      <label className="mini-settings-switch">
        <span>
          <strong>{t("botSettings.common.aiEnabled")}</strong>
          <small>{t("botSettings.common.aiEnabledHint")}</small>
        </span>
        <input
          type="checkbox"
          checked={enabled}
          disabled={saving}
          onChange={(event) => setEnabled(event.target.checked)}
        />
      </label>
      <label className="mini-settings-prompt">
        <span>
          {t("botSettings.common.systemPrompt")}
          <small>{t("botSettings.common.promptLength", { count: systemPrompt.length })}</small>
        </span>
        <textarea
          value={systemPrompt}
          disabled={saving}
          maxLength={50_000}
          rows={4}
          onChange={(event) => setSystemPrompt(event.target.value)}
        />
      </label>
      <div className="mini-ai-actions">
        <button
          type="button"
          className="is-secondary"
          disabled={!changed || saving}
          onClick={() => {
            setEnabled(settings.ai.enabled);
            setSystemPrompt(settings.ai.systemPrompt);
            setLatest(null);
            setFeedback(null);
          }}
        >
          {t("botSettings.common.discard")}
        </button>
        <button type="button" disabled={!changed || saving} onClick={() => void save()}>
          <Save aria-hidden="true" />
          {t(saving ? "botSettings.common.saving" : "botSettings.common.save")}
        </button>
      </div>
      <FeedbackLine feedback={feedback} />
      {latest ? (
        <div className="mini-ai-conflict" role="alert">
          <AlertTriangle aria-hidden="true" />
          <span>
            <strong>{t("botSettings.common.conflictTitle")}</strong>
            {t("botSettings.common.conflictBody")}
          </span>
          <button type="button" onClick={() => adopt(latest)}>
            {t("botSettings.common.useLatest")}
          </button>
        </div>
      ) : null}
    </section>
  );
}

export function BotSettingsPage({
  botId,
  session,
}: {
  botId: string;
  session: MiniAppSessionView;
}) {
  const { t } = useTranslation("miniApp");
  const [lifecycle, setLifecycle] = useState<BotLifecycleView | null>(null);
  const [settings, setSettings] = useState<BotSettingsView | null>(null);
  const [failed, setFailed] = useState(false);

  const load = useCallback(async () => {
    setFailed(false);
    try {
      const [nextLifecycle, nextSettings] = await Promise.all([
        fetchBotLifecycle(botId),
        fetchBotSettings(botId),
      ]);
      setLifecycle(nextLifecycle);
      setSettings(nextSettings);
    } catch {
      setFailed(true);
    }
  }, [botId]);

  useEffect(() => {
    void load();
  }, [load]);

  if (!lifecycle || !settings) {
    return (
      <main className="mini-app-content mini-ai-settings mini-groups-state">
        {failed ? (
          <>
            <AlertTriangle aria-hidden="true" />
            <h1>{t("botSettings.unavailableTitle")}</h1>
            <p>{t("botSettings.unavailableBody")}</p>
            <button type="button" onClick={() => void load()}>
              <RefreshCw aria-hidden="true" />
              {t("botSettings.retry")}
            </button>
          </>
        ) : (
          <>
            <span className="mini-app-loader" />
            <p>{t("botSettings.loading")}</p>
          </>
        )}
      </main>
    );
  }

  return (
    <main className="mini-app-content mini-ai-settings mini-bot-settings">
      <header className="mini-settings-page-heading">
        <p>{t("botSettings.eyebrow")}</p>
        <h1>{t("botSettings.title")}</h1>
      </header>
      <LifecycleCard
        botId={botId}
        csrfToken={session.csrfToken}
        lifecycle={lifecycle}
        onChange={setLifecycle}
      />
      <GlobalAiSelectionSettings botId={botId} session={session} />
      <CommonSettingsCard
        botId={botId}
        csrfToken={session.csrfToken}
        settings={settings}
        onChange={setSettings}
      />
    </main>
  );
}
