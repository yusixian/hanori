/** Request states. `pr` requests only use open/merged/closed; `bug` requests walk the rest. */
export const REQUEST_STATES = {
  open: "open",
  received: "received",
  queued: "queued",
  starting: "starting",
  running: "running",
  prReady: "pr_ready",
  revising: "revising",
  needsAttention: "needs_attention",
  needsSpec: "needs_spec",
  merged: "merged",
  closed: "closed",
  cancelled: "cancelled",
  failed: "failed",
} as const;

const S = REQUEST_STATES;

export const WAITING_STATES = [S.received, S.queued];
/** Sessions that are actively writing; these count against machine and project concurrency. */
export const ACTIVE_STATES = [S.starting, S.running, S.revising];
/** Unmerged work that still holds its areas for `sameAreaWriters`. */
export const AREA_HOLDING_STATES = [...ACTIVE_STATES, S.prReady, S.needsAttention];
export const OPEN_PR_STATES = [S.open, S.prReady, S.revising, S.needsAttention];
export const TERMINAL_STATES = [S.merged, S.closed, S.cancelled, S.failed];

export const JOB_STATES = {
  starting: "starting",
  running: "running",
  done: "done",
  cancelled: "cancelled",
  lost: "lost",
  failed: "failed",
} as const;

export const LIVE_JOB_STATES = [JOB_STATES.starting, JOB_STATES.running];

export function isOpenPrState(state: string): boolean {
  return (OPEN_PR_STATES as readonly string[]).includes(state);
}

export function isTerminal(state: string): boolean {
  return (TERMINAL_STATES as readonly string[]).includes(state);
}

/** Areas a request writes to; undeclared means the whole repository. */
export const WHOLE_REPO = "*";

export function requestAreas(areas: readonly string[] | null | undefined): string[] {
  return areas && areas.length > 0 ? [...areas] : [WHOLE_REPO];
}

export function areasConflict(a: readonly string[], b: readonly string[]): boolean {
  if (a.includes(WHOLE_REPO) || b.includes(WHOLE_REPO)) return true;
  return a.some((area) => b.includes(area));
}
