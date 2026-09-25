import type {
  HarnessAdminExecutionView,
  HarnessAdminMachine,
  HarnessAdminProject,
  HarnessAdminProjectPatch,
} from "@cos-tool-bot/shared";
import { Save, Trash2 } from "lucide-react";
import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { HarnessAdminApiError, type HarnessAdminApi } from "@/lib/harness-admin-client";
import { ProjectExecutionSection, projectExecutionPatch } from "./execution-settings";
import { buildPolicyPatch, policyDraftFrom, sameMachines, type PolicyDraft } from "./policy-draft";
import {
  ApiErrorNotice,
  issuesAt,
  MachinePicker,
  Notice,
  PolicyAdvancedFields,
  PolicySummaryList,
  TextField,
} from "./project-fields";
import { ProjectOverview } from "./project-list";
import "./i18n";

const CLAIMED_PATHS = ["machines", "localProject", "policyPatch"];

interface DetailProps {
  api: HarnessAdminApi;
  project: HarnessAdminProject;
  machines: readonly HarnessAdminMachine[];
  execution: HarnessAdminExecutionView;
  onSaved: (project: HarnessAdminProject) => void;
  onDeleted: (key: string) => void;
  onOpenLink?: (url: string) => boolean;
}

function toApiError(cause: unknown): HarnessAdminApiError {
  return cause instanceof HarnessAdminApiError
    ? cause
    : new HarnessAdminApiError(String(cause), 0, "unavailable");
}

/** Remounts the editor after each save so every draft restarts from the server's values. */
export function ProjectDetail(props: DetailProps) {
  const [revision, setRevision] = useState(0);
  const [saved, setSaved] = useState(false);
  return (
    <ProjectEditor
      key={`${props.project.key}:${revision}`}
      {...props}
      saved={saved}
      onEdit={() => setSaved(false)}
      onSaved={(next) => {
        props.onSaved(next);
        setRevision((value) => value + 1);
        setSaved(true);
      }}
    />
  );
}

function ProjectEditor({
  api,
  project,
  machines,
  execution,
  saved,
  onEdit,
  onSaved,
  onDeleted,
  onOpenLink,
}: DetailProps & { saved: boolean; onEdit: () => void }) {
  const { t } = useTranslation("harness");
  const editable = project.editable;
  const initialDraft = useMemo(() => policyDraftFrom(project.policy), [project.policy]);
  const [selectedMachines, setSelectedMachines] = useState(project.machines);
  const [localProject, setLocalProject] = useState(project.localProject);
  const [draft, setDraft] = useState<PolicyDraft>(initialDraft);
  const [resetPolicy, setResetPolicy] = useState(false);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [overrideExecution, setOverrideExecution] = useState(project.execution.panel !== null);
  const [executionDraft, setExecutionDraft] = useState(
    project.execution.panel ?? project.execution.effective,
  );
  const [busy, setBusy] = useState<"save" | "delete" | null>(null);
  const [error, setError] = useState<HarnessAdminApiError | null>(null);
  const [confirming, setConfirming] = useState(false);

  const patch: HarnessAdminProjectPatch = {};
  if (editable) {
    if (!sameMachines(selectedMachines, project.machines)) patch.machines = selectedMachines;
    if (localProject.trim() !== project.localProject) {
      patch.localProject = localProject.trim() || null;
    }
    if (resetPolicy) {
      patch.policyPatch = null;
    } else {
      const policyPatch = buildPolicyPatch(initialDraft, draft, project.policyPatch);
      if (policyPatch) patch.policyPatch = policyPatch;
    }
  }
  const executionPatch = projectExecutionPatch(
    project.execution.panel,
    overrideExecution,
    executionDraft,
  );
  if (executionPatch !== undefined) patch.execution = executionPatch;
  const dirty = Object.keys(patch).length > 0;
  const canSave = dirty && busy === null;
  const issues = error?.issues ?? [];
  const edit =
    <T,>(setter: (value: T) => void) =>
    (value: T) => {
      setter(value);
      onEdit();
    };

  const save = async () => {
    if (!canSave) return;
    setBusy("save");
    setError(null);
    onEdit();
    try {
      onSaved(await api.updateProject(project.key, patch));
    } catch (cause) {
      const failure = toApiError(cause);
      setError(failure);
      if (issuesAt(failure.issues, "policyPatch").length > 0) setAdvancedOpen(true);
      setBusy(null);
    }
  };

  const remove = async () => {
    setBusy("delete");
    setError(null);
    try {
      await api.deleteProject(project.key);
      onDeleted(project.key);
    } catch (cause) {
      setError(toApiError(cause));
      setBusy(null);
    }
  };

  return (
    <form
      className="harness-form"
      onSubmit={(event) => {
        event.preventDefault();
        void save();
      }}
    >
      {!editable ? (
        <Notice kind="warning">
          <strong>{t("edit.readOnlyHint")}</strong>
          <span>{t("edit.readOnly")}</span>
        </Notice>
      ) : null}
      <ProjectOverview
        project={project}
        machines={machines}
        agents={execution.agents}
        onOpenLink={onOpenLink}
      />

      {editable ? (
        <section className="harness-card">
          <h2>{t("edit.title")}</h2>
          <MachinePicker
            machines={machines}
            selected={selectedMachines}
            disabled={busy !== null}
            errors={issuesAt(issues, "machines")}
            onChange={edit(setSelectedMachines)}
          />
          <TextField
            label={t("fields.localProject")}
            hint={t("fields.localProjectHint")}
            value={localProject}
            disabled={busy !== null}
            errors={issuesAt(issues, "localProject")}
            onChange={edit(setLocalProject)}
          />
        </section>
      ) : null}

      <ProjectExecutionSection
        agents={execution.agents}
        globalEffective={execution.effective}
        projectEffective={project.execution.effective}
        enabled={overrideExecution}
        draft={executionDraft}
        disabled={busy !== null}
        onToggle={edit(setOverrideExecution)}
        onChange={edit(setExecutionDraft)}
      />

      <section className="harness-card">
        <h2>{t("fields.policy")}</h2>
        <PolicySummaryList policy={project.policy} />
        {editable ? (
          <PolicyAdvancedFields
            draft={draft}
            open={advancedOpen}
            disabled={busy !== null || resetPolicy}
            errors={issues}
            onToggle={setAdvancedOpen}
            onChange={edit(setDraft)}
            footer={
              project.policyPatch ? (
                <div className="harness-footer">
                  <span className="harness-hint">
                    {t(resetPolicy ? "edit.resetPending" : "edit.overridden")}
                  </span>
                  <button
                    type="button"
                    className="harness-button is-secondary"
                    aria-pressed={resetPolicy}
                    disabled={busy !== null}
                    onClick={() => {
                      setResetPolicy((value) => !value);
                      setDraft(initialDraft);
                      onEdit();
                    }}
                  >
                    {t(resetPolicy ? "edit.cancel" : "edit.resetPolicy")}
                  </button>
                </div>
              ) : null
            }
          />
        ) : null}
      </section>

      {error ? <ApiErrorNotice error={error} claimedPaths={CLAIMED_PATHS} /> : null}
      {saved ? <Notice kind="success">{t("edit.saved")}</Notice> : null}

      {confirming ? (
        <div className="harness-confirm" role="alertdialog" aria-labelledby="harness-delete-title">
          <p id="harness-delete-title">{t("edit.deleteConfirm", { key: project.key })}</p>
          <div className="harness-actions">
            <button
              type="button"
              className="harness-button is-danger"
              disabled={busy !== null}
              onClick={() => void remove()}
            >
              <Trash2 aria-hidden="true" />
              {t(busy === "delete" ? "edit.deleting" : "edit.confirmDelete")}
            </button>
            <button
              type="button"
              className="harness-button is-secondary"
              disabled={busy !== null}
              autoFocus
              onClick={() => setConfirming(false)}
            >
              {t("edit.cancel")}
            </button>
          </div>
        </div>
      ) : null}

      <div className="harness-footer">
        {editable ? (
          <button
            type="button"
            className="harness-button is-danger-outline"
            disabled={busy !== null || confirming}
            onClick={() => setConfirming(true)}
          >
            <Trash2 aria-hidden="true" />
            {t("edit.delete")}
          </button>
        ) : (
          <span />
        )}
        <button
          type="submit"
          className="harness-button"
          disabled={!canSave}
          title={dirty ? undefined : t("edit.noChanges")}
        >
          <Save aria-hidden="true" />
          {t(busy === "save" ? "edit.saving" : "edit.save")}
        </button>
      </div>
    </form>
  );
}
