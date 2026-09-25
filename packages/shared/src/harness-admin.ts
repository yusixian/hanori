/**
 * Contract for managing Dev Harness projects from the web panel and the Telegram Mini App.
 * Both surfaces call the same relative paths:
 * web `/api/harness/admin/*` (panel owner) and Mini App `/api/mini-app/:botId/harness/*`
 * (the harness Bot, a user listed in `telegram.owners`).
 *
 * GET    /overview          -> HarnessAdminOverview
 * GET    /repos             -> HarnessAdminRepoList
 * POST   /preview           HarnessAdminPreviewInput -> HarnessAdminPreview
 * POST   /projects          HarnessAdminProjectInput -> { project }
 * PATCH  /projects/:key     HarnessAdminProjectPatch -> { project }
 * DELETE /projects/:key     -> {}
 * PUT    /execution         HarnessAdminExecution -> { execution: HarnessAdminExecutionView }
 *
 * Every response is `{ ok: true, ...body }` or HarnessAdminError.
 */

/** `native` covers desktop or mobile apps built without Electron, e.g. Swift/Xcode projects. */
export const HARNESS_PROJECT_KINDS = ["web", "electron", "native", "service", "library"] as const;
export type HarnessProjectKind = (typeof HARNESS_PROJECT_KINDS)[number];

export type HarnessRiskTier = "T0" | "T1" | "T2" | "T3";

/** `yaml` projects come from harness.yaml and are read-only in the GUI; YAML wins on a clash. */
export type HarnessProjectSource = "yaml" | "panel";

/** Where the base repository policy came from before panel edits are applied. */
export type HarnessPolicySource = "repo" | "inferred" | "default";

export interface HarnessAdminPolicySummary {
  source: HarnessPolicySource;
  kind: HarnessProjectKind;
  verify: { quick: string | null; full: string | null; acceptance: string | null };
  releaseFragment: "required" | "optional";
  preferSkills: string[];
  riskDefault: HarnessRiskTier;
  /** Owner-declared T3 globs; the fixed T3 paths (.cos/**, workflows, release-kit config) always apply. */
  riskT3: string[];
  /** Why the policy could not be read or inferred; the effective policy then falls back to defaults. */
  error: string | null;
}

/** The subset of `.cos/harness.yml` the GUI can edit; stored per project and applied above the repo file. */
export interface HarnessAdminPolicyPatch {
  kind?: HarnessProjectKind;
  verify?: { quick?: string | null; full?: string | null; acceptance?: string | null };
  contract?: { releaseFragment?: "required" | "optional" };
  prompts?: { preferSkills?: string[] };
}

export interface HarnessAdminMachine {
  /** Key used in project `machines`, e.g. `mbp`. */
  key: string;
  lodyName: string;
  /** null when Lody could not be reached. */
  online: boolean | null;
}

export interface HarnessAdminProject {
  key: string;
  repo: string;
  source: HarnessProjectSource;
  editable: boolean;
  machines: string[];
  localProject: string;
  topic: { threadId: number | null; url: string | null; error: string | null };
  policy: HarnessAdminPolicySummary;
  policyPatch: HarnessAdminPolicyPatch | null;
  /** Effective execution for this project and the panel override, if any. */
  execution: { effective: HarnessAdminExecution; panel: HarnessAdminExecution | null };
}

export interface HarnessAdminOverview {
  enabled: boolean;
  /** Present when harness.yaml failed to load; the GUI shows it instead of the project list. */
  configError: string | null;
  chatId: number | null;
  projects: HarnessAdminProject[];
  machines: HarnessAdminMachine[];
  execution: HarnessAdminExecutionView;
  /** Stored panel projects that did not take effect, e.g. their key or repo is also in harness.yaml. */
  warnings?: string[];
}

/** Which Lody agent config, model, and reasoning effort the worker (lead) session uses. */
export interface HarnessAdminExecution {
  /** Lody agent config id (preferred) or exact name. */
  agentConfig: string | null;
  model: string | null;
  effort: string | null;
}

export interface HarnessAdminModelOption {
  id: string;
  name: string;
  efforts: string[];
}

export interface HarnessAdminAgentOption {
  id: string;
  name: string;
  /** Lody agent type, e.g. `codex` or `claude`; drives quota and the effort option key. */
  agentType: string;
  /** From the built-in or YAML model catalog for this agent type; the GUI also allows a custom id. */
  models: HarnessAdminModelOption[];
}

export interface HarnessAdminExecutionView {
  /** Effective global value after YAML and panel settings. */
  effective: HarnessAdminExecution;
  /** Panel-stored global value; null fields fall through to YAML / built-in defaults. */
  panel: HarnessAdminExecution | null;
  /** null when Lody could not be reached. */
  agents: HarnessAdminAgentOption[] | null;
}

export interface HarnessAdminRepo {
  fullName: string;
  private: boolean;
  defaultBranch: string | null;
  /** Already bound to a project (YAML or panel). */
  tracked: boolean;
}

export interface HarnessAdminRepoList {
  repos: HarnessAdminRepo[];
  /** Where the owner grants the GitHub App access to more repositories. */
  installUrl: string | null;
}

export interface HarnessAdminPreviewInput {
  repo: string;
}

export interface HarnessAdminPreview {
  repo: string;
  suggestedKey: string;
  suggestedLocalProject: string;
  policy: HarnessAdminPolicySummary;
}

export interface HarnessAdminProjectInput {
  key: string;
  repo: string;
  machines: string[];
  /** Lody local project name, id, or path on the machine; defaults to the repository name. */
  localProject?: string | null;
  policyPatch?: HarnessAdminPolicyPatch | null;
  /** Per-project override; works for YAML projects too since it is stored separately. */
  execution?: HarnessAdminExecution | null;
}

export type HarnessAdminProjectPatch = Partial<
  Pick<HarnessAdminProjectInput, "machines" | "localProject" | "policyPatch" | "execution">
>;

export type HarnessAdminErrorCode =
  | "not_enabled"
  | "forbidden"
  | "not_found"
  | "conflict"
  | "read_only"
  | "invalid"
  | "github_unavailable";

export interface HarnessAdminError {
  ok: false;
  code: HarnessAdminErrorCode;
  error: string;
  issues?: Array<{ path: string; message: string }>;
}
