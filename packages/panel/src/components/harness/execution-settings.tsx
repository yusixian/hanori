import type {
  HarnessAdminAgentOption,
  HarnessAdminExecution,
  HarnessAdminExecutionView,
  HarnessAdminRuntimeUpdate,
} from "@cos-tool-bot/shared";
import { ChevronDown, Cpu, Download, RefreshCw, RotateCcw, Save } from "lucide-react";
import { useId, useState } from "react";
import { useTranslation } from "react-i18next";
import { HarnessAdminApiError, type HarnessAdminApi } from "@/lib/harness-admin-client";
import {
  activeAgent,
  DEFAULT_EXECUTION,
  findAgent,
  findModel,
  formatExecution,
  normalizeExecution,
  sameExecution,
  withAgent,
  withModel,
} from "./execution-draft";
import { ApiErrorNotice, Notice } from "./project-fields";
import "./i18n";

const CUSTOM_MODEL = "__custom__";
const FIELDS = ["agentConfig", "model", "effort"] as const;

function FreeText({
  id,
  value,
  disabled,
  placeholder,
  list,
  label,
  onChange,
}: {
  id: string;
  value: string | null;
  disabled?: boolean;
  placeholder?: string;
  list?: string;
  label?: string;
  onChange: (value: string | null) => void;
}) {
  return (
    <input
      id={id}
      className="harness-input"
      value={value ?? ""}
      disabled={disabled}
      placeholder={placeholder}
      list={list}
      aria-label={label}
      autoCapitalize="off"
      autoCorrect="off"
      spellCheck={false}
      onChange={(event) => onChange(event.target.value || null)}
    />
  );
}

export function ExecutionFields({
  agents,
  draft,
  effective,
  disabled,
  onChange,
}: {
  agents: readonly HarnessAdminAgentOption[] | null;
  draft: HarnessAdminExecution;
  /** Values null draft fields fall through to. */
  effective: HarnessAdminExecution;
  disabled?: boolean;
  onChange: (next: HarnessAdminExecution) => void;
}) {
  const { t } = useTranslation("harness");
  const id = useId();
  const agent = activeAgent(agents, draft, effective);
  const selectedAgent = findAgent(agents, draft.agentConfig);
  const [customModel, setCustomModel] = useState(
    Boolean(agent && draft.model && !findModel(agent, draft.model)),
  );
  const model = findModel(agent, draft.model ?? effective.model);
  const efforts = customModel ? undefined : model?.efforts;
  const allEfforts = [...new Set(agent?.models.flatMap((option) => option.efforts) ?? [])];

  return (
    <div className="harness-grid-2">
      <div className="harness-field">
        <label htmlFor={`${id}-agent`}>{t("execution.agent")}</label>
        {agents ? (
          <select
            id={`${id}-agent`}
            className="harness-select"
            value={selectedAgent?.id ?? draft.agentConfig ?? ""}
            disabled={disabled}
            onChange={(event) => {
              setCustomModel(false);
              onChange(withAgent(draft, event.target.value || null, agents, effective));
            }}
          >
            <option value="">{t("execution.default")}</option>
            {draft.agentConfig && !selectedAgent ? (
              <option value={draft.agentConfig}>
                {t("execution.unknownAgent", { value: draft.agentConfig })}
              </option>
            ) : null}
            {agents.map((option) => (
              <option key={option.id} value={option.id}>
                {`${option.name} · ${option.agentType}`}
              </option>
            ))}
          </select>
        ) : (
          <FreeText
            id={`${id}-agent`}
            value={draft.agentConfig}
            disabled={disabled}
            placeholder={t("execution.default")}
            onChange={(agentConfig) => onChange({ ...draft, agentConfig })}
          />
        )}
      </div>

      <div className="harness-field">
        <label htmlFor={`${id}-model`}>{t("execution.model")}</label>
        {agent ? (
          <select
            id={`${id}-model`}
            className="harness-select"
            value={customModel ? CUSTOM_MODEL : (draft.model ?? "")}
            disabled={disabled}
            onChange={(event) => {
              const value = event.target.value;
              if (value === CUSTOM_MODEL) {
                setCustomModel(true);
                return;
              }
              setCustomModel(false);
              onChange(withModel(draft, value || null, agent, effective));
            }}
          >
            <option value="">{t("execution.default")}</option>
            {agent.models.map((option) => (
              <option key={option.id} value={option.id}>
                {option.name}
              </option>
            ))}
            <option value={CUSTOM_MODEL}>{t("execution.custom")}</option>
          </select>
        ) : null}
        {!agent || customModel ? (
          <FreeText
            id={agent ? `${id}-model-custom` : `${id}-model`}
            value={draft.model}
            disabled={disabled}
            label={agent ? t("execution.customModel") : undefined}
            placeholder={agent ? t("execution.customModel") : t("execution.default")}
            onChange={(value) => onChange({ ...draft, model: value })}
          />
        ) : null}
      </div>

      <div className="harness-field">
        <label htmlFor={`${id}-effort`}>{t("execution.effort")}</label>
        {efforts && efforts.length > 0 ? (
          <select
            id={`${id}-effort`}
            className="harness-select"
            value={draft.effort ?? ""}
            disabled={disabled}
            onChange={(event) => onChange({ ...draft, effort: event.target.value || null })}
          >
            <option value="">{t("execution.default")}</option>
            {draft.effort && !efforts.includes(draft.effort) ? (
              <option value={draft.effort}>{draft.effort}</option>
            ) : null}
            {efforts.map((effort) => (
              <option key={effort} value={effort}>
                {effort}
              </option>
            ))}
          </select>
        ) : (
          <>
            <FreeText
              id={`${id}-effort`}
              value={draft.effort}
              disabled={disabled || efforts?.length === 0}
              placeholder={t("execution.default")}
              list={allEfforts.length > 0 ? `${id}-efforts` : undefined}
              onChange={(effort) => onChange({ ...draft, effort })}
            />
            {allEfforts.length > 0 ? (
              <datalist id={`${id}-efforts`}>
                {allEfforts.map((effort) => (
                  <option key={effort} value={effort} />
                ))}
              </datalist>
            ) : null}
          </>
        )}
      </div>
    </div>
  );
}

export function ExecutionSources({
  effective,
  panel,
  agents,
}: {
  effective: HarnessAdminExecution;
  panel: HarnessAdminExecution | null;
  agents: readonly HarnessAdminAgentOption[] | null;
}) {
  const { t } = useTranslation("harness");
  const agent = findAgent(agents, effective.agentConfig);
  const display = {
    agentConfig: agent ? agent.name : effective.agentConfig,
    model: findModel(agent, effective.model)?.name ?? effective.model,
    effort: effective.effort,
  };
  const labels = {
    agentConfig: "execution.agent",
    model: "execution.model",
    effort: "execution.effort",
  } as const;
  return (
    <dl className="harness-meta">
      {FIELDS.map((field) => (
        <div key={field}>
          <dt>{t(labels[field])}</dt>
          <dd>
            <span>{display[field] ?? "—"}</span>
            {field === "agentConfig" && agent ? (
              <span className="harness-badge">{agent.agentType}</span>
            ) : null}
            <span className={panel?.[field] ? "harness-badge is-accent" : "harness-badge"}>
              {t(panel?.[field] ? "execution.fromPanel" : "execution.fromDefault")}
            </span>
          </dd>
        </div>
      ))}
    </dl>
  );
}

export function GlobalExecutionCard({
  api,
  view,
  onSaved,
}: {
  api: HarnessAdminApi;
  view: HarnessAdminExecutionView;
  onSaved: (view: HarnessAdminExecutionView) => void;
}) {
  const { t } = useTranslation("harness");
  const [draft, setDraft] = useState(view.panel ?? DEFAULT_EXECUTION);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState<"save" | "restore" | "refresh" | "update" | null>(null);
  const [error, setError] = useState<HarnessAdminApiError | null>(null);
  const [saved, setSaved] = useState(false);
  const [runtimeResult, setRuntimeResult] = useState<HarnessAdminRuntimeUpdate | null>(null);
  const [refreshed, setRefreshed] = useState(false);
  const dirty = !sameExecution(normalizeExecution(draft), view.panel ?? DEFAULT_EXECUTION);
  const summary = formatExecution(view.effective, view.agents);
  const maintaining = busy !== null || view.runtime?.updating === true;

  const maintain = async (action: "refresh" | "update") => {
    setBusy(action);
    setError(null);
    setRefreshed(false);
    setRuntimeResult(null);
    try {
      if (action === "update") setRuntimeResult(await api.updateRuntime());
      onSaved(await api.refreshExecution());
      setRefreshed(true);
    } catch (cause) {
      setError(
        cause instanceof HarnessAdminApiError
          ? cause
          : new HarnessAdminApiError(String(cause), 0, "unavailable"),
      );
    } finally {
      setBusy(null);
    }
  };

  const submit = async (execution: HarnessAdminExecution, action: "save" | "restore") => {
    setBusy(action);
    setError(null);
    setSaved(false);
    try {
      const next = await api.updateExecution(execution);
      setDraft(next.panel ?? DEFAULT_EXECUTION);
      setSaved(true);
      onSaved(next);
    } catch (cause) {
      setError(
        cause instanceof HarnessAdminApiError
          ? cause
          : new HarnessAdminApiError(String(cause), 0, "unavailable"),
      );
    } finally {
      setBusy(null);
    }
  };

  return (
    <section className="harness-card" aria-labelledby="harness-execution-title">
      <div className="harness-project-head">
        <div>
          <h2 id="harness-execution-title">{t("execution.title")}</h2>
          <span className="harness-hint">{t("execution.intro")}</span>
        </div>
        <Cpu aria-hidden="true" width={18} height={18} className="harness-muted-icon" />
      </div>
      <p className="harness-summary-line">
        <span className="harness-hint">{t("execution.effective")}</span>
        <strong>{summary ?? t("execution.default")}</strong>
      </p>
      <div className="harness-runtime">
        {view.runtime ? (
          <p className="harness-hint">
            {t("execution.cliVersion", {
              machine: view.runtime.machineName,
              version: runtimeResult?.version ?? view.runtime.version ?? "—",
            })}
          </p>
        ) : null}
        <div className="harness-actions">
          <button
            type="button"
            className="harness-button is-secondary"
            disabled={maintaining}
            onClick={() => void maintain("refresh")}
          >
            <RefreshCw aria-hidden="true" />
            {t(busy === "refresh" ? "execution.refreshing" : "execution.refreshModels")}
          </button>
          <button
            type="button"
            className="harness-button is-secondary"
            disabled={maintaining || !view.runtime?.canUpdate}
            onClick={() => void maintain("update")}
          >
            <Download aria-hidden="true" />
            {t(
              busy === "update" || view.runtime?.updating
                ? "execution.updatingCli"
                : "execution.updateCli",
            )}
          </button>
        </div>
        <p className="harness-hint">
          {t(
            view.runtime?.canUpdate ? "execution.updateCliHint" : "execution.updateCliUnavailable",
          )}
        </p>
      </div>
      {view.agents === null ? (
        <Notice kind="warning">
          {t("execution.unreachable")}
          {view.agentError ? <p>{view.agentError}</p> : null}
        </Notice>
      ) : null}
      {runtimeResult ? (
        <Notice kind="success">
          {t(runtimeResult.updated ? "execution.cliUpdated" : "execution.cliCurrent", {
            version: runtimeResult.version,
          })}
        </Notice>
      ) : null}
      {refreshed && !runtimeResult ? (
        <Notice kind="success">{t("execution.modelsRefreshed")}</Notice>
      ) : null}
      {error ? <ApiErrorNotice error={error} /> : null}
      <details
        className="harness-advanced"
        open={open}
        onToggle={(event) => setOpen(event.currentTarget.open)}
      >
        <summary>
          {t("execution.edit")}
          <ChevronDown aria-hidden="true" />
        </summary>
        <div>
          <ExecutionSources effective={view.effective} panel={view.panel} agents={view.agents} />
          <ExecutionFields
            agents={view.agents}
            draft={draft}
            effective={view.effective}
            disabled={maintaining}
            onChange={(next) => {
              setDraft(next);
              setSaved(false);
            }}
          />
          {saved ? <Notice kind="success">{t("execution.saved")}</Notice> : null}
          <div className="harness-footer">
            <button
              type="button"
              className="harness-button is-secondary"
              disabled={maintaining || view.panel === null}
              onClick={() => void submit(DEFAULT_EXECUTION, "restore")}
            >
              <RotateCcw aria-hidden="true" />
              {t("execution.restore")}
            </button>
            <button
              type="button"
              className="harness-button"
              disabled={maintaining || !dirty}
              onClick={() => void submit(normalizeExecution(draft), "save")}
            >
              <Save aria-hidden="true" />
              {t(busy === "save" ? "execution.saving" : "execution.save")}
            </button>
          </div>
        </div>
      </details>
    </section>
  );
}

/** Returns the `execution` patch value, or undefined when the override did not change. */
export function projectExecutionPatch(
  initialPanel: HarnessAdminExecution | null,
  enabled: boolean,
  draft: HarnessAdminExecution,
): HarnessAdminExecution | null | undefined {
  if (!enabled) return initialPanel === null ? undefined : null;
  const next = normalizeExecution(draft);
  return initialPanel && sameExecution(initialPanel, next) ? undefined : next;
}

export function ProjectExecutionSection({
  agents,
  globalEffective,
  projectEffective,
  enabled,
  draft,
  disabled,
  onToggle,
  onChange,
}: {
  agents: readonly HarnessAdminAgentOption[] | null;
  globalEffective: HarnessAdminExecution;
  projectEffective: HarnessAdminExecution;
  enabled: boolean;
  draft: HarnessAdminExecution;
  disabled?: boolean;
  onToggle: (enabled: boolean) => void;
  onChange: (next: HarnessAdminExecution) => void;
}) {
  const { t } = useTranslation("harness");
  return (
    <section className="harness-card">
      <h2>{t("execution.title")}</h2>
      <p className="harness-summary-line">
        <span className="harness-hint">{t("execution.effective")}</span>
        <strong>{formatExecution(projectEffective, agents) ?? t("execution.default")}</strong>
      </p>
      <label className="harness-check">
        <input
          type="checkbox"
          checked={enabled}
          disabled={disabled}
          onChange={(event) => onToggle(event.target.checked)}
        />
        <span>
          <strong>{t("execution.projectOverride")}</strong>
        </span>
      </label>
      {enabled ? (
        <ExecutionFields
          agents={agents}
          draft={draft}
          effective={globalEffective}
          disabled={disabled}
          onChange={onChange}
        />
      ) : (
        <p className="harness-hint">{t("execution.projectOverrideHint")}</p>
      )}
    </section>
  );
}
