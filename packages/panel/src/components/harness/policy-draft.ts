import type {
  HarnessAdminPolicyPatch,
  HarnessAdminPolicySummary,
  HarnessProjectKind,
} from "@cos-tool-bot/shared";

export interface PolicyDraft {
  kind: HarnessProjectKind;
  verifyQuick: string;
  verifyFull: string;
  verifyAcceptance: string;
  releaseFragment: "required" | "optional";
  preferSkills: string;
}

export function policyDraftFrom(policy: HarnessAdminPolicySummary): PolicyDraft {
  return {
    kind: policy.kind,
    verifyQuick: policy.verify.quick ?? "",
    verifyFull: policy.verify.full ?? "",
    verifyAcceptance: policy.verify.acceptance ?? "",
    releaseFragment: policy.releaseFragment,
    preferSkills: policy.preferSkills.join(", "),
  };
}

export function parseSkills(value: string): string[] {
  return [
    ...new Set(
      value
        .split(/[,，、\s]+/)
        .map((skill) => skill.trim())
        .filter(Boolean),
    ),
  ];
}

function command(value: string): string | null {
  return value.trim() || null;
}

/**
 * Builds a patch holding only the fields that differ from `initial`, layered over the project's
 * existing panel patch so earlier overrides survive. Returns undefined when nothing changed.
 */
export function buildPolicyPatch(
  initial: PolicyDraft,
  draft: PolicyDraft,
  existing: HarnessAdminPolicyPatch | null = null,
): HarnessAdminPolicyPatch | undefined {
  const patch: HarnessAdminPolicyPatch = structuredClone(existing ?? {});
  let changed = false;

  if (draft.kind !== initial.kind) {
    patch.kind = draft.kind;
    changed = true;
  }
  const verifyFields = [
    ["quick", "verifyQuick"],
    ["full", "verifyFull"],
    ["acceptance", "verifyAcceptance"],
  ] as const;
  for (const [field, key] of verifyFields) {
    if (command(draft[key]) !== command(initial[key])) {
      patch.verify = { ...patch.verify, [field]: command(draft[key]) };
      changed = true;
    }
  }
  if (draft.releaseFragment !== initial.releaseFragment) {
    patch.contract = { ...patch.contract, releaseFragment: draft.releaseFragment };
    changed = true;
  }
  const skills = parseSkills(draft.preferSkills);
  if (skills.join("\0") !== parseSkills(initial.preferSkills).join("\0")) {
    patch.prompts = { ...patch.prompts, preferSkills: skills };
    changed = true;
  }
  return changed ? patch : undefined;
}

export function sameMachines(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) return false;
  const set = new Set(left);
  return right.every((machine) => set.has(machine));
}
