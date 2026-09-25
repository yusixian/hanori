import type { HarnessCallbackAnswer } from "@cos-tool-bot/bot";
import { APPROVAL_PROBLEM_TEXT, type CardVerb, checkApproval } from "./approvals.js";
import type { HarnessPrFlow } from "./pr-flow.js";
import type { HarnessService } from "./service.js";
import type { HarnessApprovalRecord, HarnessRequestRecord } from "./store.js";

export function errorText(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 200);
}

/** PR card buttons; callers hold the PR lock so a concurrent sync cannot interleave. */
export class HarnessPrActions {
  constructor(
    private readonly service: HarnessService,
    private readonly flow: HarnessPrFlow,
  ) {}

  private get github() {
    const github = this.service.github;
    if (!github?.available) throw new Error("GitHub App 未配置");
    return github;
  }

  async dispatch(
    verb: CardVerb,
    approval: HarnessApprovalRecord,
    request: HarnessRequestRecord,
    actorId: number,
  ): Promise<HarnessCallbackAnswer> {
    const number = request.prNumber!;
    const check = checkApproval(approval, this.service.now());
    if (!check.ok) {
      if (check.problem !== "consumed") {
        await this.flow.syncUnlocked(request.projectKey, number, { reason: "stale_button" });
      }
      return { text: APPROVAL_PROBLEM_TEXT[check.problem] };
    }
    switch (verb) {
      case "details":
        await this.markViewed(approval, request);
        await this.flow.syncUnlocked(request.projectKey, number, {
          reason: "details",
          expanded: true,
        });
        return { text: "已展开详情" };
      case "collapse":
        await this.flow.syncUnlocked(request.projectKey, number, { reason: "collapse" });
        return { text: "已收起" };
      case "refresh":
        await this.flow.syncUnlocked(request.projectKey, number, { reason: "refresh" });
        return { text: "已刷新" };
      case "cancel":
        await this.flow.syncUnlocked(request.projectKey, number, { reason: "merge_cancelled" });
        return { text: "已取消" };
      case "merge":
        if (this.flow.project(request.projectKey).approvals.mergeConfirm === "twice") {
          return this.askConfirm(approval, request);
        }
        return this.merge(approval, request, actorId, { confirmed: false });
      case "confirm":
        return this.merge(approval, request, actorId, { confirmed: true });
      default:
        return { text: APPROVAL_PROBLEM_TEXT.missing };
    }
  }

  /** Records that the owner saw the details of the approved head, which T2 merges require. */
  private async markViewed(approval: HarnessApprovalRecord, request: HarnessRequestRecord) {
    const config = this.flow.project(request.projectKey);
    const pr = await this.github.getPullRequest(config.project.repo, request.prNumber!);
    if (approval.headSha === pr.headSha) {
      await this.service.store.updateRequest(request.id, { detailsViewedSha: pr.headSha });
    }
  }

  /** The confirmation step shows the details inline, so confirming a T2 merge implies reading them. */
  private async askConfirm(
    approval: HarnessApprovalRecord,
    request: HarnessRequestRecord,
  ): Promise<HarnessCallbackAnswer> {
    await this.markViewed(approval, request);
    await this.flow.syncUnlocked(request.projectKey, request.prNumber!, {
      reason: "confirm",
      confirmingMerge: true,
    });
    return { text: "请确认合并" };
  }

  /** Re-checks the live PR against the approval before consuming it; GitHub also pins the SHA. */
  private async merge(
    approval: HarnessApprovalRecord,
    request: HarnessRequestRecord,
    actorId: number,
    options: { confirmed: boolean },
  ): Promise<HarnessCallbackAnswer> {
    const { service } = this;
    const config = this.flow.project(request.projectKey);
    const repo = config.project.repo;
    const pr = await this.github.getPullRequest(repo, request.prNumber!);
    const event = (type: string, payload: Record<string, unknown>) =>
      service.recordEvent({
        type,
        projectKey: request.projectKey,
        requestId: request.id,
        approvalId: approval.id,
        actorId,
        payload,
      });
    const reject = async (reason: string, text: string): Promise<HarnessCallbackAnswer> => {
      await event("merge.rejected", { reason });
      await this.flow.syncUnlocked(request.projectKey, pr.number, {
        reason: `merge_rejected.${reason}`,
      });
      return { text, alert: true };
    };
    if (pr.merged) return reject("already_merged", "PR 已合并");
    if (pr.state !== "open") return reject("closed", "PR 已关闭");
    if (pr.draft) return reject("draft", "草稿 PR 不能合并");
    if (pr.headSha !== approval.headSha)
      return reject("head_changed", "PR 有新提交，请看刷新后的卡片");
    const evaluation = await this.flow.evaluate(config, pr, request);
    if (evaluation.risk.tier === "T3") return reject("t3", "T3 改动只能在 GitHub 网页上合并");
    if (evaluation.checks.awaitingRegistration) {
      return reject("checks_unregistered", "CI 尚未登记，请稍候");
    }
    if (evaluation.checks.state === "failure" || evaluation.checks.state === "pending") {
      return reject("checks", "CI 尚未全绿");
    }
    if (pr.mergeable === false) return reject("conflict", "存在冲突，无法合并");
    if (evaluation.risk.tier === "T2" && request.detailsViewedSha !== pr.headSha) {
      if (!options.confirmed) return this.askConfirm(approval, request);
      return reject("details_required", "T2 改动需要先查看详情");
    }
    if (!(await service.store.consumeApproval(approval.id, actorId, service.now()))) {
      return { text: APPROVAL_PROBLEM_TEXT.consumed };
    }
    try {
      const result = await this.github.mergePullRequest(repo, pr.number, {
        sha: approval.headSha,
        method: config.github.mergeMethod,
      });
      if (!result.merged) throw new Error(result.message);
      await event("merge.succeeded", {
        number: pr.number,
        sha: result.sha,
        method: config.github.mergeMethod,
      });
    } catch (error) {
      await event("merge.failed", { message: errorText(error) });
      await this.flow.syncUnlocked(request.projectKey, pr.number, {
        reason: "merge_failed",
        note: `合并失败：${errorText(error)}`,
      });
      return { text: `合并失败：${errorText(error)}`, alert: true };
    }
    if (config.github.deleteBranchOnMerge && pr.headRepo?.toLowerCase() === repo.toLowerCase()) {
      await this.github.deleteBranch(repo, pr.headRef).catch((error) =>
        service.recordEvent({
          type: "branch.delete_failed",
          projectKey: request.projectKey,
          requestId: request.id,
          payload: { branch: pr.headRef, message: errorText(error) },
        }),
      );
    }
    await this.flow.syncUnlocked(request.projectKey, pr.number, { reason: "merged" });
    return { text: "已合并" };
  }
}
