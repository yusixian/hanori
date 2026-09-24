import type { HarnessAdminPolicySummary, HarnessPolicySource } from "@cos-tool-bot/shared";
import { HarnessAdminError } from "./admin-execution.js";
import { formatIssues, isPlainObject } from "./config/layers.js";
import { GLOBAL_SCOPE, resolveProjectConfig } from "./config/resolve.js";
import type { ProjectEffectiveConfig } from "./config/schema.js";
import type { HarnessService } from "./service.js";

function policySummary(
  config: ProjectEffectiveConfig,
  source: HarnessPolicySource,
  error: string | null,
): HarnessAdminPolicySummary {
  const { policy } = config;
  return {
    source,
    kind: policy.kind,
    verify: {
      quick: policy.verify.quick,
      full: policy.verify.full,
      acceptance: policy.verify.acceptance,
    },
    sizeGateMaxFiles: policy.sizeGate.maxFiles,
    releaseFragment: policy.contract.releaseFragment,
    preferSkills: [...policy.prompts.preferSkills],
    riskDefault: policy.risk.default,
    riskT3: [...policy.risk.T3],
    error,
  };
}

export function suggestKey(repoName: string, taken: (key: string) => boolean): string {
  const base =
    repoName
      .toLowerCase()
      .replace(/[^a-z0-9_-]+/g, "-")
      .replace(/^[^a-z0-9]+/, "")
      .slice(0, 28)
      .replace(/-+$/, "") || "project";
  const candidates = [base, ...Array.from({ length: 50 }, (_, index) => `${base}-${index + 2}`)];
  return candidates.find((key) => key !== GLOBAL_SCOPE && !taken(key)) ?? base;
}

/**
 * The policy with the panel patch applied but without Telegram TTL overrides, which the GUI does
 * not edit; `source` still names the base layer under the patch.
 */
export function projectPolicySummary(
  service: HarnessService,
  key: string,
): HarnessAdminPolicySummary | null {
  const record = service.projectRecord(key);
  const input = service.projectInput(key, []);
  const resolved = resolveProjectConfig(input);
  const fallback = resolved.ok
    ? resolved
    : resolveProjectConfig({ ...input, policy: null, inferred: null });
  if (!fallback.ok) return null;
  const source: HarnessPolicySource = !resolved.ok
    ? "default"
    : record?.policy
      ? "repo"
      : record?.inferredPolicy
        ? "inferred"
        : "default";
  const githubNote = service.github?.available ? null : "GitHub App 未配置，使用默认值";
  return policySummary(fallback.value, source, record?.policyError ?? githubNote);
}

export function summarizeCandidate(
  service: HarnessService,
  repo: string,
  policy: Record<string, unknown> | null,
  inferred: Record<string, unknown> | null,
  error: string | null,
): HarnessAdminPolicySummary {
  // Not a valid project key, so it can never collide with a real entry.
  const key = "__candidate__";
  const raw = service.loadedConfig!.raw;
  const projects = isPlainObject(raw.projects) ? raw.projects : {};
  const input = {
    raw: { ...raw, projects: { ...projects, [key]: { repo } } },
    projectKey: key,
    overrides: [],
    now: service.now(),
  };
  const resolved = resolveProjectConfig({ ...input, policy, inferred });
  if (resolved.ok) {
    const source = policy ? "repo" : inferred ? "inferred" : "default";
    return policySummary(resolved.value, source, error);
  }
  const fallback = resolveProjectConfig({ ...input, policy: null, inferred: null });
  if (!fallback.ok) throw new HarnessAdminError("invalid", formatIssues(fallback.issues, 3));
  return policySummary(fallback.value, "default", error ?? formatIssues(resolved.issues, 3));
}
