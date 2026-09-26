import type { ReleaseInfo, WorkflowRunInfo } from "./github-release.js";
import { RELEASE_STATES, type ReleaseRun, type ReleaseSnapshot } from "./release-card.js";
import type { ReleasePlan } from "./release-plan.js";

export const TRACK_LIMIT_MS = 2 * 60 * 60_000;
/** A green run may publish its Release a little later. */
export const SUCCESS_GRACE_MS = 2 * 60_000;
const failed = (run: WorkflowRunInfo) =>
  run.status === "completed" && run.conclusion !== null && run.conclusion !== "success";

/**
 * The latest tag push run of each workflow the plan detected. Tag push runs stand in only when none
 * was detected, so a generic `on: push` CI run cannot finish the tracking for the release run.
 */
function releaseRuns(
  runs: readonly WorkflowRunInfo[],
  plan: Pick<ReleasePlan, "tag" | "workflows">,
): WorkflowRunInfo[] {
  const tagRuns = runs
    .filter((run) => run.event === "push" && run.headBranch === plan.tag)
    .sort((a, b) => b.id - a.id);
  const latest = new Map<string, WorkflowRunInfo>();
  for (const run of tagRuns) {
    const key = plan.workflows.length
      ? plan.workflows.find((workflow) => run.path?.endsWith(`/${workflow.file}`))?.file
      : (run.path ?? run.name);
    if (key && !latest.has(key)) latest.set(key, run);
  }
  return [...latest.values()];
}

export function toReleaseRun(run: WorkflowRunInfo): ReleaseRun {
  return {
    id: run.id,
    name: run.name,
    status: run.status,
    conclusion: run.conclusion,
    url: run.url,
  };
}

export interface TrackObservation {
  release: ReleaseInfo | null;
  /** Null when the App cannot read Actions. */
  runs: WorkflowRunInfo[] | null;
  now: Date;
}

/** Folds one poll into the snapshot and decides the card state. */
export function observeRelease(
  snapshot: ReleaseSnapshot,
  observation: TrackObservation,
  taggedAt: Date,
): { state: string; snapshot: ReleaseSnapshot } {
  const { release, runs, now } = observation;
  const tracked = runs ? releaseRuns(runs, snapshot.plan) : [];
  const failure = tracked.find(failed);
  const run = failure ?? tracked.find((run) => run.status !== "completed") ?? tracked[0];
  const next: ReleaseSnapshot = {
    ...snapshot,
    actionsReadable: runs !== null,
    run: run ? toReleaseRun(run) : runs === null ? null : snapshot.run,
    release: release ? { url: release.url, draft: release.draft } : null,
  };
  const S = RELEASE_STATES;
  if (release && !release.draft) return { state: S.published, snapshot: next };
  if (failure) return { state: S.failed, snapshot: next };
  if (
    tracked.length > 0 &&
    tracked.length >= snapshot.plan.workflows.length &&
    tracked.every((run) => run.status === "completed" && run.conclusion === "success")
  ) {
    const finishedAt = Math.max(
      ...tracked.map((run) => (run.updatedAt ? new Date(run.updatedAt).getTime() : now.getTime())),
    );
    if (release || now.getTime() - finishedAt >= SUCCESS_GRACE_MS) {
      return { state: S.published, snapshot: next };
    }
  }
  if (now.getTime() - taggedAt.getTime() >= TRACK_LIMIT_MS) {
    return { state: S.timedOut, snapshot: next };
  }
  return { state: S.building, snapshot: next };
}

const clip = (text: string, max: number) => {
  const single = text.replace(/\s+/g, " ").trim();
  return single.length > max ? `${single.slice(0, max - 1)}…` : single;
};

/** The `/task` instruction behind 「准备发版」: version files and notes in a PR, never a tag. */
export function prepInstruction(plan: ReleasePlan): string {
  const previous = plan.previous?.tag ?? "(none)";
  const title = `chore(release): v${plan.version}`;
  const notes = plan.releaseKit
    ? "This repository uses @coszone/release-kit (release-kit.yaml): follow its fragment and versioning rules."
    : "Follow the repository's existing convention (CHANGELOG, release notes file, or the notes the release workflow reads).";
  const changes = plan.changes
    .slice(0, 20)
    .map((change) => `- ${change.number ? `#${change.number} ` : ""}${clip(change.title, 120)}`);
  return [
    `Prepare release v${plan.version} of ${plan.repo} (previous tag: ${previous}; base: ${plan.defaultBranch} @ ${plan.targetSha.slice(0, 7)}).`,
    `1. Bump the version to ${plan.version} in every file where this repository declares it (for example package.json, Project.swift, Cargo.toml, or release-kit files). Check how the previous release commit did it.`,
    `2. Write the release notes for v${plan.version}. ${notes}`,
    `3. Open a pull request against ${plan.defaultBranch} titled \`${title}\`.`,
    "Do not create or push any git tag, do not create a GitHub Release, and do not merge the pull request: the owner tags the release from Telegram after it merges.",
    ...(changes.length > 0 ? ["", `Changes since ${previous}:`, ...changes] : []),
  ].join("\n");
}
