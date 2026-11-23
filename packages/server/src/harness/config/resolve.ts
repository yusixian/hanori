import {
  type ConfigLayer,
  type LayeredResult,
  isPlainObject,
  parseLayered,
  setPath,
  splitPath,
} from "./layers.js";
import {
  DEFAULT_ROLES,
  type HarnessFileConfig,
  PROJECT_KINDS,
  PROJECT_OVERRIDABLE_KEYS,
  type ProjectEffectiveConfig,
  type ProjectKind,
  harnessFileSchema,
  kindDefaultsLayer,
  projectEffectiveSchema,
} from "./schema.js";

export const GLOBAL_SCOPE = "global";

export interface HarnessOverride {
  scope: string;
  path: string;
  value: unknown;
  expiresAt: Date | null;
  actorId: number | null;
  updatedAt: Date;
}

/**
 * Security-relevant fields stay YAML-only (dev-harness-config.md §2), plus bindings and paths
 * that would execute a local binary or redirect credentials.
 */
const LOCKED_PATHS = [
  "version",
  "telegram.bot",
  "telegram.chatId",
  "telegram.owners",
  "approvals",
  "risk",
  "policy.risk",
  "policy.version",
  "executors.lody.cli",
  "executors.lody.bridge",
  "github.webhookSecretEnv",
  "github.acceptIssues",
  "github.acceptPullRequests",
  "github.trustedAuthors",
  "deploy.dokploy",
  "guardrails.autonomy.autoMergeTiers",
  "project",
  "projects",
].map((path) => path.split("."));

function startsWith(path: readonly string[], prefix: readonly string[]): boolean {
  return prefix.length <= path.length && prefix.every((segment, index) => path[index] === segment);
}

/** Locked when the path is, contains, or sits under a locked field. */
export function isLockedPath(path: readonly string[]): boolean {
  return LOCKED_PATHS.some((locked) => startsWith(path, locked) || startsWith(locked, path));
}

export function activeOverrides(
  overrides: readonly HarnessOverride[],
  scope: string,
  now: Date,
): HarnessOverride[] {
  return overrides.filter(
    (override) =>
      override.scope === scope && (override.expiresAt === null || override.expiresAt > now),
  );
}

function overrideLayer(
  name: "override:global" | "override:project",
  overrides: readonly HarnessOverride[],
): ConfigLayer {
  let data: Record<string, unknown> = {};
  for (const override of [...overrides].sort((a, b) => a.path.localeCompare(b.path))) {
    const path = splitPath(override.path);
    if (path) data = setPath(data, path, override.value);
  }
  return { name, data, locate: (path) => `覆盖层 ${path.join(".")}` };
}

function withoutKeys(value: Record<string, unknown>, keys: readonly string[]) {
  return Object.fromEntries(Object.entries(value).filter(([key]) => !keys.includes(key)));
}

const defaultLayer = (): ConfigLayer => ({ name: "default", data: { roles: DEFAULT_ROLES } });

function panelGlobalLayer(data: Record<string, unknown> | null | undefined): ConfigLayer[] {
  return data
    ? [{ name: "panel:global", data, locate: (path) => `面板设置（全局）${path.join(".")}` }]
    : [];
}

/** `panelGlobal` is panel-managed data (the lead's execution) above harness.yaml. */
export function globalLayers(
  raw: Record<string, unknown>,
  overrides: readonly HarnessOverride[],
  now: Date,
  panelGlobal?: Record<string, unknown> | null,
): ConfigLayer[] {
  return [
    defaultLayer(),
    { name: "yaml", data: raw },
    ...panelGlobalLayer(panelGlobal),
    overrideLayer("override:global", activeOverrides(overrides, GLOBAL_SCOPE, now)),
  ];
}

export function resolveGlobalConfig(
  raw: Record<string, unknown>,
  overrides: readonly HarnessOverride[],
  now: Date,
  panelGlobal?: Record<string, unknown> | null,
): LayeredResult<HarnessFileConfig> & { layers: ConfigLayer[] } {
  const layers = globalLayers(raw, overrides, now, panelGlobal);
  return { ...parseLayered(harnessFileSchema, layers), layers };
}

function resolveKind(candidates: readonly unknown[]): ProjectKind {
  for (const candidate of candidates) {
    if (PROJECT_KINDS.includes(candidate as ProjectKind)) return candidate as ProjectKind;
  }
  return "web";
}

export interface ProjectLayerInput {
  raw: Record<string, unknown>;
  projectKey: string;
  /** Parsed repository policy; null when the repo has none. */
  policy: Record<string, unknown> | null;
  /** Used in place of the repo layer only when `policy` is null. */
  inferred?: Record<string, unknown> | null;
  /** Panel-managed projects keep their binding out of harness.yaml. */
  panel?: {
    binding: boolean;
    policyPatch: Record<string, unknown> | null;
    /** Layer data for this project's lead execution; allowed for YAML projects too. */
    execution?: Record<string, unknown> | null;
  } | null;
  panelGlobal?: Record<string, unknown> | null;
  overrides: readonly HarnessOverride[];
  now: Date;
}

export function projectLayers(input: ProjectLayerInput): ConfigLayer[] {
  const { raw, projectKey, now } = input;
  const projects = isPlainObject(raw.projects) ? raw.projects : {};
  const entry = isPlainObject(projects[projectKey]) ? projects[projectKey] : {};
  const binding = withoutKeys(entry, PROJECT_OVERRIDABLE_KEYS);
  const projectOverrides = Object.fromEntries(
    Object.entries(entry).filter(([key]) =>
      (PROJECT_OVERRIDABLE_KEYS as readonly string[]).includes(key),
    ),
  );
  const globalOverride = overrideLayer(
    "override:global",
    activeOverrides(input.overrides, GLOBAL_SCOPE, now),
  );
  const projectOverride = overrideLayer(
    "override:project",
    activeOverrides(input.overrides, projectKey, now),
  );
  const panelBinding = input.panel?.binding ?? false;
  const patch = input.panel?.policyPatch ?? {};
  const execution = input.panel?.execution ?? {};
  const inferred = input.policy === null ? (input.inferred ?? null) : null;
  const basePolicy = inferred ?? input.policy ?? {};
  const base: ConfigLayer = inferred
    ? {
        name: "inferred",
        data: { policy: inferred },
        locate: (path) => `按仓库推断 ${path.slice(1).join(".") || "(根)"}`,
      }
    : {
        name: "repo",
        data: { policy: basePolicy },
        locate: (path) => `仓库策略文件: ${path.slice(1).join(".") || "(根)"}`,
      };
  const overriddenKind = (projectOverride.data.policy as Record<string, unknown> | undefined)?.kind;
  const kind = resolveKind([overriddenKind, patch.kind, basePolicy.kind]);

  const layers: ConfigLayer[] = [
    defaultLayer(),
    { name: "kind", data: kindDefaultsLayer(kind) },
    { name: "yaml", data: withoutKeys(raw, ["version", "projects"]) },
    {
      name: "yaml:project",
      data: panelBinding
        ? { project: { key: projectKey } }
        : { ...projectOverrides, project: { ...binding, key: projectKey } },
      locate: (path) =>
        `projects.${projectKey}.${(path[0] === "project" ? path.slice(1) : path).join(".")}`,
    },
    base,
    ...panelGlobalLayer(input.panelGlobal),
  ];
  if (panelBinding || Object.keys(patch).length > 0 || Object.keys(execution).length > 0) {
    layers.push({
      name: "panel",
      data: {
        ...execution,
        ...(panelBinding ? { project: binding } : {}),
        ...(Object.keys(patch).length > 0 ? { policy: patch } : {}),
      },
      locate: (path) =>
        `面板设置 ${(path[0] === "project" || path[0] === "policy" ? path.slice(1) : path).join(".")}`,
    });
  }
  layers.push(globalOverride, projectOverride);
  return layers;
}

export function resolveProjectConfig(
  input: ProjectLayerInput,
): LayeredResult<ProjectEffectiveConfig> & { layers: ConfigLayer[] } {
  const layers = projectLayers(input);
  return { ...parseLayered(projectEffectiveSchema, layers), layers };
}
