import {
  type ConfigLayer,
  type LayeredResult,
  isPlainObject,
  parseLayered,
  setPath,
  splitPath,
} from "./layers.js";
import {
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

export function globalLayers(
  raw: Record<string, unknown>,
  overrides: readonly HarnessOverride[],
  now: Date,
): ConfigLayer[] {
  return [
    { name: "yaml", data: raw },
    overrideLayer("override:global", activeOverrides(overrides, GLOBAL_SCOPE, now)),
  ];
}

export function resolveGlobalConfig(
  raw: Record<string, unknown>,
  overrides: readonly HarnessOverride[],
  now: Date,
): LayeredResult<HarnessFileConfig> & { layers: ConfigLayer[] } {
  const layers = globalLayers(raw, overrides, now);
  return { ...parseLayered(harnessFileSchema, layers), layers };
}

function resolveKind(candidates: readonly unknown[]): ProjectKind {
  for (const candidate of candidates) {
    if (PROJECT_KINDS.includes(candidate as ProjectKind)) return candidate as ProjectKind;
  }
  return "web";
}

export function projectLayers(input: {
  raw: Record<string, unknown>;
  projectKey: string;
  policy: Record<string, unknown> | null;
  overrides: readonly HarnessOverride[];
  now: Date;
}): ConfigLayer[] {
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
  const policy = input.policy ?? {};
  const overriddenKind = (projectOverride.data.policy as Record<string, unknown> | undefined)?.kind;
  const kind = resolveKind([overriddenKind, policy.kind]);

  return [
    { name: "kind", data: kindDefaultsLayer(kind) },
    { name: "yaml", data: withoutKeys(raw, ["version", "projects"]) },
    {
      name: "yaml:project",
      data: { ...projectOverrides, project: { ...binding, key: projectKey } },
      locate: (path) =>
        `projects.${projectKey}.${(path[0] === "project" ? path.slice(1) : path).join(".")}`,
    },
    {
      name: "repo",
      data: { policy },
      locate: (path) => `.cos/harness.yml: ${path.slice(1).join(".") || "(根)"}`,
    },
    globalOverride,
    projectOverride,
  ];
}

export function resolveProjectConfig(
  input: Parameters<typeof projectLayers>[0],
): LayeredResult<ProjectEffectiveConfig> & { layers: ConfigLayer[] } {
  const layers = projectLayers(input);
  return { ...parseLayered(projectEffectiveSchema, layers), layers };
}
