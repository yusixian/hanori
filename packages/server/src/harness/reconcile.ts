import { durationMs } from "./config/units.js";
import { errorText } from "./pr-actions.js";
import { harnessBranch } from "./prompts.js";
import { REQUEST_STATES as S, isTerminal } from "./states.js";
import type { HarnessRequestRecord } from "./store.js";
import type { HarnessWork } from "./work.js";

const OPEN_STATES = Object.values(S).filter((state) => !isTerminal(state));
/** Bug requests whose session may have opened a PR the webhook never told us about. */
const MAY_HAVE_PR: readonly string[] = [S.running, S.needsAttention];

function needsReconcile(request: HarnessRequestRecord): boolean {
  if (request.prNumber !== null) return true;
  return request.type === "bug" && MAY_HAVE_PR.includes(request.state);
}

/**
 * Catches up on webhooks lost to a crash or restart after the 202: re-syncs open requests from
 * GitHub through the same PR sync the webhook path uses, a bounded batch per interval.
 */
export class HarnessReconciler {
  private lastRunAt: number | null = null;
  private cursor = 0;

  constructor(private readonly work: HarnessWork) {}

  async run(): Promise<void> {
    const { service } = this.work;
    const { interval, batch } = service.globalView().config.github.reconcile;
    if (!interval || !service.github?.available) return;
    const now = service.now().getTime();
    if (this.lastRunAt !== null && now - this.lastRunAt < durationMs(interval)) return;
    this.lastRunAt = now;
    const candidates = (await service.store.listRequestsByState(OPEN_STATES)).filter(
      needsReconcile,
    );
    if (candidates.length === 0) return;
    const start = this.cursor % candidates.length;
    const picked = [...candidates.slice(start), ...candidates.slice(0, start)].slice(0, batch);
    this.cursor = start + picked.length;
    for (const request of picked) {
      try {
        await this.reconcile(request);
      } catch (error) {
        service.logger.warn(`Dev Harness reconcile ${request.id} failed: ${errorText(error)}`);
      }
    }
  }

  private async reconcile(request: HarnessRequestRecord) {
    const { service } = this.work;
    if (request.prNumber !== null) {
      await service.prFlow.sync(request.projectKey, request.prNumber, { reason: "reconcile" });
      return;
    }
    const config = this.work.config(request.projectKey);
    if (!config) return;
    const branch = harnessBranch(config.github.branchPrefix, request.id);
    const number = await this.work.github.findOpenPullRequest(config.project.repo, branch);
    if (number === null) return;
    await service.recordEvent({
      type: "reconcile.pr_found",
      projectKey: request.projectKey,
      requestId: request.id,
      payload: { number },
    });
    await service.prFlow.sync(request.projectKey, number, { reason: "reconcile" });
  }
}
