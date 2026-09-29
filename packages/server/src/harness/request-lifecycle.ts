import type { PullRequestInfo } from "./github.js";
import { REQUEST_STATES as S, isTerminal, isWorkRequest } from "./states.js";
import type { HarnessRequestPatch, HarnessRequestRecord, HarnessStore } from "./store.js";

/**
 * Request lifecycle. `state` is only written by a compare-and-set against the state the writer
 * read: `transitionRequest` for writers holding the request lock (`req:<id>`), and
 * `optimisticTransition` for writers that cannot take it, like the PR sync under the PR lock.
 * `HarnessRequestPatch` cannot carry `state`, so no writer overwrites a transition made meanwhile.
 */

/** Attempts after the first before `optimisticTransition` gives up. */
export const TRANSITION_RETRIES = 2;

export interface Transition {
  to: string;
  /** Written together with `to`. */
  fields?: HarnessRequestPatch;
  /** Written even when the transition loses: what the attempt already did outside the database. */
  facts?: HarnessRequestPatch;
  /** Runs once, after the transition won. */
  after?: () => Promise<void>;
}

/**
 * `decide` gets a snapshot and returns its transition, which lands only while the request is still
 * in the snapshot's state. When another writer moved it first, only `facts` are written and
 * `decide` runs again on a fresh read, at most `TRANSITION_RETRIES` more times. False when no
 * attempt won or the request is gone.
 */
export async function optimisticTransition(
  store: Pick<HarnessStore, "getRequest" | "transitionRequest" | "updateRequest">,
  snapshot: HarnessRequestRecord,
  decide: (snapshot: HarnessRequestRecord) => Promise<Transition>,
): Promise<boolean> {
  let current: HarnessRequestRecord | null = snapshot;
  for (let attempt = 0; current && attempt <= TRANSITION_RETRIES; attempt++) {
    const { to, fields, facts = {}, after } = await decide(current);
    if (await store.transitionRequest(current.id, [current.state], to, { ...fields, ...facts })) {
      await after?.();
      return true;
    }
    if (Object.keys(facts).length > 0) await store.updateRequest(current.id, facts);
    current = await store.getRequest(current.id);
  }
  return false;
}

const KEPT_WHILE_OPEN: readonly string[] = [
  S.received,
  S.queued,
  S.starting,
  S.needsAttention,
  S.needsSpec,
];

function openPrState(request: Pick<HarnessRequestRecord, "type" | "state">, headChanged: boolean) {
  if (!isWorkRequest(request)) return S.open;
  if (request.state === S.completed) return S.prReady;
  if (isTerminal(request.state) && request.state !== S.closed) return request.state;
  if (KEPT_WHILE_OPEN.includes(request.state)) return request.state;
  if (request.state === S.revising || request.state === S.running) {
    return headChanged ? S.prReady : request.state;
  }
  return S.prReady;
}

/**
 * The transition a PR implies for its request. Merged and closed come from GitHub. While the PR is
 * open a `pr` request is `open`; a work request keeps its own stage until a push from its session
 * (first linking counts as one) moves it to `pr_ready`, which clears the previous stage's reason.
 */
export function prTransition(
  request: Pick<HarnessRequestRecord, "type" | "state">,
  pr: Pick<PullRequestInfo, "merged" | "state">,
  headChanged: boolean,
): { to: string; fields: HarnessRequestPatch } {
  const to = pr.merged
    ? S.merged
    : pr.state === "closed"
      ? S.closed
      : openPrState(request, headChanged);
  const entersReady = to === S.prReady && request.state !== S.prReady;
  return { to, fields: entersReady ? { stateReason: null } : {} };
}
