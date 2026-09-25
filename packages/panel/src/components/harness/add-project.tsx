import type {
  HarnessAdminMachine,
  HarnessAdminPreview,
  HarnessAdminProject,
  HarnessAdminProjectInput,
} from "@cos-tool-bot/shared";
import { GitBranch, Save } from "lucide-react";
import { useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  HARNESS_PROJECT_KEY_PATTERN,
  HarnessAdminApiError,
  type HarnessAdminApi,
} from "@/lib/harness-admin-client";
import { buildPolicyPatch, policyDraftFrom, type PolicyDraft } from "./policy-draft";
import {
  ApiErrorNotice,
  issuesAt,
  MachinePicker,
  PolicyAdvancedFields,
  PolicySummaryList,
  TextField,
} from "./project-fields";
import { RepoPicker } from "./repo-picker";
import "./i18n";

const CLAIMED_PATHS = ["key", "machines", "localProject", "policyPatch"];

function toApiError(cause: unknown): HarnessAdminApiError {
  return cause instanceof HarnessAdminApiError
    ? cause
    : new HarnessAdminApiError(String(cause), 0, "unavailable");
}

interface PreviewState {
  preview: HarnessAdminPreview;
  initialDraft: PolicyDraft;
}

export function AddProject({
  api,
  machines,
  onCreated,
  onOpenLink,
}: {
  api: HarnessAdminApi;
  machines: readonly HarnessAdminMachine[];
  onCreated: (project: HarnessAdminProject) => void;
  onOpenLink?: (url: string) => boolean;
}) {
  const { t } = useTranslation("harness");
  const [repo, setRepo] = useState<string | null>(null);
  const [state, setState] = useState<PreviewState | null>(null);
  const [previewError, setPreviewError] = useState<HarnessAdminApiError | null>(null);
  const [key, setKey] = useState("");
  const [localProject, setLocalProject] = useState("");
  const [selectedMachines, setSelectedMachines] = useState(() =>
    machines.filter((machine) => machine.online !== false).map((machine) => machine.key),
  );
  const [draft, setDraft] = useState<PolicyDraft | null>(null);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<HarnessAdminApiError | null>(null);
  const previewRequest = useRef(0);

  const choose = async (next: string) => {
    const request = ++previewRequest.current;
    setRepo(next);
    setState(null);
    setPreviewError(null);
    setSaveError(null);
    try {
      const preview = await api.preview(next);
      if (request !== previewRequest.current) return;
      const initialDraft = policyDraftFrom(preview.policy);
      setState({ preview, initialDraft });
      setKey(preview.suggestedKey);
      setLocalProject(preview.suggestedLocalProject);
      setDraft(initialDraft);
    } catch (cause) {
      if (request === previewRequest.current) setPreviewError(toApiError(cause));
    }
  };

  const reset = () => {
    previewRequest.current += 1;
    setRepo(null);
    setState(null);
    setPreviewError(null);
    setSaveError(null);
  };

  const issues = saveError?.issues ?? [];
  const keyValid = HARNESS_PROJECT_KEY_PATTERN.test(key);
  const keyErrors = [
    ...(key && !keyValid ? [t("fields.keyInvalid")] : []),
    ...issuesAt(issues, "key"),
  ];
  const canSave = Boolean(state && draft && keyValid && !saving);

  const save = async () => {
    if (!state || !draft || !canSave) return;
    const input: HarnessAdminProjectInput = {
      key,
      repo: state.preview.repo,
      machines: selectedMachines,
    };
    const trimmedLocal = localProject.trim();
    if (trimmedLocal !== state.preview.suggestedLocalProject) {
      input.localProject = trimmedLocal || null;
    }
    const policyPatch = buildPolicyPatch(state.initialDraft, draft);
    if (policyPatch) input.policyPatch = policyPatch;

    setSaving(true);
    setSaveError(null);
    try {
      onCreated(await api.createProject(input));
    } catch (cause) {
      const error = toApiError(cause);
      setSaveError(error);
      if (issuesAt(error.issues, "policyPatch").length > 0) setAdvancedOpen(true);
    } finally {
      setSaving(false);
    }
  };

  if (!repo) {
    return <RepoPicker api={api} selected={null} onSelect={choose} onOpenLink={onOpenLink} />;
  }

  return (
    <form
      className="harness-form"
      onSubmit={(event) => {
        event.preventDefault();
        void save();
      }}
    >
      <section className="harness-card">
        <div className="harness-project-head">
          <div>
            <h2>{t("add.details")}</h2>
            <span className="harness-mono">
              <GitBranch aria-hidden="true" width={12} height={12} /> {repo}
            </span>
          </div>
          <button
            type="button"
            className="harness-button is-secondary"
            disabled={saving}
            onClick={reset}
          >
            {t("add.changeRepo")}
          </button>
        </div>

        {!state && !previewError ? (
          <p className="harness-inline-status" role="status">
            <span className="harness-loader" />
            {t("add.previewing")}
          </p>
        ) : null}
        {previewError ? (
          <>
            <ApiErrorNotice error={previewError} />
            <div className="harness-actions">
              <button type="button" className="harness-button" onClick={() => void choose(repo)}>
                {t("retry")}
              </button>
            </div>
          </>
        ) : null}

        {state && draft ? (
          <>
            <TextField
              label={t("fields.key")}
              hint={t("fields.keyHint")}
              value={key}
              disabled={saving}
              errors={keyErrors}
              onChange={(value) => setKey(value.trim())}
            />
            <TextField
              label={t("fields.localProject")}
              hint={t("fields.localProjectHint")}
              value={localProject}
              disabled={saving}
              errors={issuesAt(issues, "localProject")}
              onChange={setLocalProject}
            />
            <MachinePicker
              machines={machines}
              selected={selectedMachines}
              disabled={saving}
              errors={issuesAt(issues, "machines")}
              onChange={setSelectedMachines}
            />
          </>
        ) : null}
      </section>

      {state && draft ? (
        <>
          <section className="harness-card">
            <h2>{t("fields.policy")}</h2>
            <PolicySummaryList policy={state.preview.policy} />
            <PolicyAdvancedFields
              draft={draft}
              open={advancedOpen}
              disabled={saving}
              errors={issues}
              onToggle={setAdvancedOpen}
              onChange={setDraft}
            />
          </section>
          {saveError ? <ApiErrorNotice error={saveError} claimedPaths={CLAIMED_PATHS} /> : null}
          <div className="harness-footer">
            <span />
            <button type="submit" className="harness-button" disabled={!canSave}>
              <Save aria-hidden="true" />
              {t(saving ? "add.saving" : "add.save")}
            </button>
          </div>
        </>
      ) : null}
    </form>
  );
}
