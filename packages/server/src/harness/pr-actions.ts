import type { HarnessCallbackAnswer } from "@cos-tool-bot/bot";
import { APPROVAL_PROBLEM_TEXT, type CardVerb, checkApproval } from "./approvals.js";
import { renderPrDetails } from "./pr-card.js";
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
        return this.showDetails(approval, request);
      case "refresh":
        await this.flow.syncUnlocked(request.projectKey, number, { reason: "refresh" });
        return { text: "已刷新" };
      case "cancel":
        await this.flow.syncUnlocked(request.projectKey, number, { reason: "merge_cancelled" });
        return { text: "已取消" };
      case "merge":
        if (this.flow.project(request.projectKey).approvals.mergeConfirm === "twice") {
          await this.flow.syncUnlocked(request.projectKey, number, {
            reason: "confirm",
            confirmingMerge: true,
          });
          return { text: "请再次确认合并" };
        }
        return this.merge(approval, request, actorId);
      case "confirm":
        return this.merge(approval, request, actorId);
      default:
        return { text: APPROVAL_PROBLEM_TEXT.missing };
    }
  }

  private async showDetails(
    approval: HarnessApprovalRecord,
    request: HarnessRequestRecord,
  ): Promise<HarnessCallbackAnswer> {
    const config = this.flow.project(request.projectKey);
    const pr = await this.github.getPullRequest(config.project.repo, request.prNumber!);
    const evaluation = await this.flow.evaluate(config, pr, request);
    await this.service.telegram?.send(this.service.file.telegram.chatId, {
      html: renderPrDetails({
        number: pr.number,
        tier: evaluation.risk.tier,
        ...evaluation,
        files: evaluation.risk.files,
      }),
      threadId: this.service.projectThread(request.projectKey),
      replyToMessageId: request.cardMessageId ?? undefined,
    });
    if (approval.headSha === pr.headSha) {
      await this.service.store.updateRequest(request.id, { detailsViewedSha: pr.headSha });
    }
    await this.flow.syncUnlocked(request.projectKey, pr.number, { reason: "details" });
    return { text: "已发送详情" };
  }

  /** Re-checks the live PR against the approval before consuming it; GitHub also pins the SHA. */
  private async merge(
    approval: HarnessApprovalRecord,
    request: HarnessRequestRecord,
    actorId: number,
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
    if (evaluation.risk.tier === "T2" && request.detailsViewedSha !== pr.headSha) {
      return reject("details_required", "T2 改动需要先查看详情");
    }
    if (evaluation.checks.state === "failure" || evaluation.checks.state === "pending") {
      return reject("checks", "CI 尚未全绿");
    }
    if (pr.mergeable === false) return reject("conflict", "存在冲突，无法合并");
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
