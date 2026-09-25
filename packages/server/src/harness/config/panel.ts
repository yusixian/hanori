import { z } from "zod";
import {
  AGENT_REF_PATTERN,
  EFFORTS,
  type ExecutionSetting,
  MODEL_ID_PATTERN,
} from "./execution.js";
import { type ConfigIssue, isPlainObject, toConfigIssues } from "./layers.js";
import type { LoadedHarnessConfig } from "./loader.js";
import { resolveGlobalConfig } from "./resolve.js";
import { PROJECT_KINDS, REPO_PATTERN } from "./schema.js";

const command = z.string().trim().min(1).max(500).nullable().optional();

/** Only these fields are editable from the GUI; risk tiers and every locked field stay out. */
export const policyPatchSchema = z.strictObject({
  kind: z.enum(PROJECT_KINDS).optional(),
  verify: z.strictObject({ quick: command, full: command, acceptance: command }).optional(),
  contract: z
    .strictObject({ releaseFragment: z.enum(["required", "optional"]).optional() })
    .optional(),
  prompts: z
    .strictObject({
      preferSkills: z
        .array(
          z
            .string()
            .trim()
            .regex(/^[\w.:-]{1,64}$/, "技能名只能包含字母、数字、. : _ -"),
        )
        .max(20)
        .optional(),
    })
    .optional(),
});

export type PolicyPatch = z.infer<typeof policyPatchSchema>;

export const panelBindingSchema = z.strictObject({
  repo: z.string().regex(REPO_PATTERN, "应为 owner/name"),
  machines: z.array(z.string().min(1)).max(20),
  localProject: z.string().trim().min(1).max(200).optional(),
});

export type PanelBinding = z.infer<typeof panelBindingSchema>;

export const executionSettingSchema = z.strictObject({
  agentConfig: z.string().trim().regex(AGENT_REF_PATTERN, "执行配置名称格式不正确").nullable(),
  model: z.string().trim().regex(MODEL_ID_PATTERN, "模型 ID 格式不正确").nullable(),
  effort: z.enum(EFFORTS).nullable(),
});

/** Null when unset or when every field falls through. */
export function parseExecutionSetting(value: unknown): ExecutionSetting | null {
  const parsed = executionSettingSchema.safeParse(value);
  if (!parsed.success) return null;
  const { agentConfig, model, effort } = parsed.data;
  return agentConfig || model || effort ? parsed.data : null;
}

export interface PanelProjectSource {
  key: string;
  binding: unknown;
}

export interface ComposedConfig {
  config: LoadedHarnessConfig;
  panelKeys: Set<string>;
  /** Panel entries that did not take effect, with the reason shown to the owner. */
  shadowed: Map<string, string>;
}

/** Drops empty objects so a patch like `{ verify: {} }` does not create a layer. */
export function compactPatch(
  patch: PolicyPatch | null | undefined,
): Record<string, unknown> | null {
  if (!patch) return null;
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue;
    if (isPlainObject(value)) {
      const inner = Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined));
      if (Object.keys(inner).length > 0) result[key] = inner;
    } else result[key] = value;
  }
  return Object.keys(result).length > 0 ? result : null;
}

export function parsePolicyPatch(value: unknown): PolicyPatch | null {
  const parsed = policyPatchSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

export function policyPatchIssues(value: unknown): ConfigIssue[] {
  const parsed = policyPatchSchema.safeParse(value);
  if (parsed.success) return [];
  return toConfigIssues(parsed.error, [
    { name: "panel", data: {}, locate: (path) => `policyPatch.${path.join(".")}` },
  ]);
}

/**
 * The effective project set is harness.yaml ∪ panel projects. YAML wins on a key or repo clash;
 * the losing panel entry stays stored and is reported instead of silently disappearing.
 */
export function composePanelProjects(
  yaml: LoadedHarnessConfig,
  panelProjects: readonly PanelProjectSource[],
  now: Date,
): ComposedConfig {
  const yamlEntries = isPlainObject(yaml.raw.projects) ? yaml.raw.projects : {};
  const repoOwners = new Map(
    Object.entries(yaml.file.projects).map(([key, project]) => [project.repo.toLowerCase(), key]),
  );
  const shadowed = new Map<string, string>();
  const accepted: Record<string, Record<string, unknown>> = {};
  for (const { key, binding } of [...panelProjects].sort((a, b) => a.key.localeCompare(b.key))) {
    const parsed = panelBindingSchema.safeParse(binding);
    if (!parsed.success) {
      shadowed.set(key, "面板中保存的绑定无法解析，已忽略");
      continue;
    }
    if (Object.hasOwn(yamlEntries, key)) {
      shadowed.set(key, "harness.yaml 中有同名项目，以 YAML 为准");
      continue;
    }
    const owner = repoOwners.get(parsed.data.repo.toLowerCase());
    if (owner !== undefined) {
      const where = owner in accepted ? "面板" : " harness.yaml ";
      shadowed.set(key, `仓库已由${where}项目 ${owner} 绑定`);
      continue;
    }
    const candidate = { ...accepted, [key]: { ...parsed.data } };
    const check = resolveGlobalConfig(
      { ...yaml.raw, projects: { ...candidate, ...yamlEntries } },
      [],
      now,
    );
    if (!check.ok) {
      shadowed.set(key, `绑定无效：${check.issues[0]?.message ?? "未知错误"}`);
      continue;
    }
    accepted[key] = { ...parsed.data };
    repoOwners.set(parsed.data.repo.toLowerCase(), key);
  }
  if (Object.keys(accepted).length === 0) {
    return { config: yaml, panelKeys: new Set(), shadowed };
  }
  const raw = { ...yaml.raw, projects: { ...accepted, ...yamlEntries } };
  const global = resolveGlobalConfig(raw, [], now);
  if (!global.ok) return { config: yaml, panelKeys: new Set(), shadowed };
  return {
    config: { ...yaml, raw, file: global.value },
    panelKeys: new Set(Object.keys(accepted)),
    shadowed,
  };
}
