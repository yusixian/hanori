import type {
  HarnessCallbackAnswer,
  HarnessCallbackRequest,
  HarnessCommandRequest,
  HarnessReply,
} from "@cos-tool-bot/bot";
import { escapeHtml } from "@cos-tool-bot/bot/utils/format";
import {
  APPROVAL_ACTIONS,
  APPROVAL_PROBLEM_TEXT,
  type CardVerb,
  checkApproval,
  ensureApproval,
} from "./approvals.js";
import { publishCard } from "./card-publisher.js";
import { httpStatus } from "./github-release.js";
import { errorText } from "./pr-actions.js";
import { RELEASE_STATES as R, type ReleaseSnapshot, renderReleaseCard } from "./release-card.js";
import {
  RELEASE_USAGE,
  type ReleasePlan,
  computeReleasePlan,
  parseReleaseArgs,
} from "./release-plan.js";
import { observeRelease, prepInstruction } from "./release-track.js";
import type { HarnessService } from "./service.js";
import type { HarnessApprovalRecord, HarnessRequestRecord } from "./store.js";

export const RELEASE_KIND = "release";
export const RELEASE_TYPE = "release";
const POLL_INTERVAL_MS = 30_000;
/** States whose card still has a 「刷新」 button that re-reads GitHub. */
const TRACKED: readonly string[] = [R.building, R.failed, R.timedOut, R.published];

const STALE = "发版计划已变化，旧按钮已失效";

const html = (text: string): HarnessReply => ({ html: text });
const short = (sha: string) => sha.slice(0, 7);
const asRef = (snapshot: ReleaseSnapshot) => snapshot as unknown as Record<string, unknown>;

/** Tagging binds to the planned commit and tag; later buttons only refresh the tracking. */
function bindingOf(request: HarnessRequestRecord): string {
  return request.state === R.planned
    ? `release:${request.headSha}:${request.title}`
    : `track:${request.title}`;
}

function planEvent(plan: ReleasePlan) {
  return { version: plan.version, tag: plan.tag, sha: plan.targetSha };
}

const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** After 「准备发版」, the tagged commit must already contain the merged `chore(release)` PR. */
function prepPending(snapshot: ReleaseSnapshot): boolean {
  if (!snapshot.prepAt) return false;
  const title = new RegExp(
    `^chore\\(release\\):\\s*v?${escapeRegExp(snapshot.plan.version)}\\b`,
    "i",
  );
  return !snapshot.plan.changes.some((change) => title.test(change.title));
}

const PREP_PENDING =
  "发版 PR 还没有合入默认分支：合并后点「刷新」再确认；不需要准备 PR 时取消后重新 /release";

/** `/release`: plan card, owner-confirmed annotated tag, then bounded tracking of the build. */
export class HarnessReleases {
  private readonly nextPoll = new Map<string, number>();

  constructor(private readonly service: HarnessService) {}

  private get work() {
    return this.service.work;
  }

  async handleCommand(
    request: HarnessCommandRequest,
    projectKey: string | undefined,
  ): Promise<HarnessReply> {
    if (!projectKey) return html("请在项目话题中使用 /release");
    const arg = parseReleaseArgs(request.args);
    if (!arg) return html(RELEASE_USAGE);
    if (!this.service.github?.available) return html("GitHub App 未配置，无法读取 tag 与提交");
    const config = this.work.config(projectKey);
    if (!config) return html(`项目 ${escapeHtml(projectKey)} 的配置无法解析`);
    const argText = request.args.trim().toLowerCase();
    const result = await this.plan(config.project.repo, projectKey, argText);
    if (!result.ok) return html(`无法生成发版计划：${escapeHtml(result.message)}`);
    await this.supersede(projectKey);
    const { plan } = result;
    const record = await this.service.store.insertRequest({
      projectKey,
      type: RELEASE_TYPE,
      state: R.planned,
      repo: config.project.repo,
      headSha: plan.targetSha,
      title: plan.tag,
      createdBy: request.userId,
    });
    await this.publish(record, this.freshSnapshot(plan, argText), {
      replyToMessageId: request.messageId,
    });
    await this.service.recordEvent({
      type: "release.planned",
      projectKey,
      requestId: record.id,
      actorId: request.userId,
      payload: { ...planEvent(plan), previous: plan.previous?.tag ?? null, bump: plan.bump },
    });
    return html("");
  }

  private plan(repo: string, projectKey: string, argText: string) {
    const arg = parseReleaseArgs(argText) ?? { kind: "auto" as const };
    const preferredWorkflow = this.work.config(projectKey)?.policy.release.stable.workflow ?? null;
    return computeReleasePlan(this.work.github, { repo, arg, preferredWorkflow }).catch(
      (error) => ({ ok: false as const, message: errorText(error) }),
    );
  }

  private freshSnapshot(plan: ReleasePlan, arg: string): ReleaseSnapshot {
    return {
      plan,
      arg,
      prepAt: null,
      taggedAt: null,
      actionsReadable: true,
      run: null,
      release: null,
      note: null,
    };
  }

  /** A newer plan for the project retires older ones, so only one card can tag. */
  private async supersede(projectKey: string) {
    const { store } = this.service;
    for (const old of await store.listRequestsByState([R.planned])) {
      if (old.projectKey !== projectKey || old.type !== RELEASE_TYPE) continue;
      await this.work.withRequest(old.id, async () => {
        if (!(await store.transitionRequest(old.id, [R.planned], R.cancelled))) return;
        await store.invalidateApprovals(
          old.id,
          "superseded",
          this.service.now(),
          undefined,
          APPROVAL_ACTIONS.release,
        );
        const fresh = await store.getRequest(old.id);
        const snapshot = fresh ? await this.load(fresh) : null;
        if (fresh && snapshot) {
          await this.publish(fresh, { ...snapshot, note: "已被新的发版计划取代" });
        }
      });
    }
  }

  async load(request: HarnessRequestRecord): Promise<ReleaseSnapshot | null> {
    if (request.chatId === null || request.cardMessageId === null) return null;
    const message = await this.service.store.findMessage(request.chatId, request.cardMessageId);
    return message?.kind === RELEASE_KIND && message.ref
      ? (message.ref as unknown as ReleaseSnapshot)
      : null;
  }

  private async publish(
    request: HarnessRequestRecord,
    snapshot: ReleaseSnapshot,
    options: { confirming?: boolean; replyToMessageId?: number } = {},
  ) {
    const { service } = this;
    const { store } = service;
    const config = this.work.config(request.projectKey);
    const final =
      request.state === R.cancelled ||
      (request.state === R.published && snapshot.release !== null && !snapshot.release.draft);
    const approval =
      final || !config
        ? null
        : await ensureApproval(store, request, {
            action: APPROVAL_ACTIONS.release,
            binding: bindingOf(request),
            ttl: config.approvals.ttl,
            now: service.now(),
          });
    const card = renderReleaseCard({
      projectKey: request.projectKey,
      state: request.state,
      snapshot,
      approvalId: approval?.id ?? null,
      confirming: options.confirming,
    });
    const patch = await publishCard(service, request.projectKey, request, card, {
      replyToMessageId: options.replyToMessageId,
    });
    if (Object.keys(patch).length > 0) await store.updateRequest(request.id, patch);
    const chatId = patch.chatId ?? request.chatId;
    const messageId = patch.cardMessageId ?? request.cardMessageId;
    if (chatId === null || messageId === null) return;
    if (await store.updateMessageRef(chatId, messageId, asRef(snapshot))) return;
    await store.recordMessage({
      chatId,
      messageId,
      requestId: request.id,
      kind: RELEASE_KIND,
      ref: asRef(snapshot),
    });
  }

  /** The caller holds the request lock and has matched the approval to the card. */
  async dispatch(
    verb: CardVerb,
    approval: HarnessApprovalRecord,
    request: HarnessRequestRecord,
    callback: HarnessCallbackRequest,
  ): Promise<HarnessCallbackAnswer> {
    const snapshot = await this.load(request);
    if (!snapshot) return { text: APPROVAL_PROBLEM_TEXT.missing };
    const checked = checkApproval(approval, this.service.now());
    if (!checked.ok) {
      if (checked.problem === "expired") await this.publish(request, snapshot);
      return {
        text: checked.problem === "invalidated" ? STALE : APPROVAL_PROBLEM_TEXT[checked.problem],
      };
    }
    if (approval.headSha !== bindingOf(request)) {
      await this.publish(request, snapshot);
      return { text: STALE };
    }
    const planned = request.state === R.planned;
    switch (verb) {
      case "refresh":
        return planned ? this.refreshPlan(request, snapshot) : this.track(request, snapshot);
      case "cancel":
        return planned ? this.cancel(request, snapshot, callback.userId) : consumed();
      case "start":
        return planned ? this.prepare(request, snapshot, callback) : consumed();
      case "merge":
      case "back":
        if (!planned) return consumed();
        if (verb === "merge" && snapshot.plan.commitCount === 0)
          return { text: "没有新提交可发布" };
        if (verb === "merge" && prepPending(snapshot)) return { text: PREP_PENDING, alert: true };
        await this.publish(request, snapshot, { confirming: verb === "merge" });
        return { text: verb === "merge" ? "请核对 tag 与提交后确认" : "已返回" };
      case "confirm":
        return planned ? this.confirm(approval, request, snapshot, callback.userId) : consumed();
      default:
        return { text: APPROVAL_PROBLEM_TEXT.missing };
    }
  }

  private async replan(request: HarnessRequestRecord, snapshot: ReleaseSnapshot, note?: string) {
    const { store } = this.service;
    const result = await this.plan(request.repo, request.projectKey, snapshot.arg);
    if (!result.ok) {
      await this.publish(request, { ...snapshot, note: `刷新失败：${result.message}` });
      return false;
    }
    const { plan } = result;
    const sameTag = plan.tag === snapshot.plan.tag;
    await store.updateRequest(request.id, { headSha: plan.targetSha, title: plan.tag });
    const fresh = (await store.getRequest(request.id))!;
    await store.invalidateApprovals(
      request.id,
      "plan_changed",
      this.service.now(),
      bindingOf(fresh),
      APPROVAL_ACTIONS.release,
    );
    await this.publish(fresh, {
      ...this.freshSnapshot(plan, snapshot.arg),
      prepAt: sameTag ? snapshot.prepAt : null,
      note: note ?? null,
    });
    return true;
  }

  private async refreshPlan(request: HarnessRequestRecord, snapshot: ReleaseSnapshot) {
    return (await this.replan(request, snapshot)) ? { text: "已刷新" } : { text: "刷新失败" };
  }

  private async cancel(request: HarnessRequestRecord, snapshot: ReleaseSnapshot, actorId: number) {
    const { store } = this.service;
    if (!(await store.transitionRequest(request.id, [R.planned], R.cancelled))) return consumed();
    await store.invalidateApprovals(
      request.id,
      "cancelled",
      this.service.now(),
      undefined,
      APPROVAL_ACTIONS.release,
    );
    await this.publish((await store.getRequest(request.id))!, { ...snapshot, note: null });
    await this.service.recordEvent({
      type: "release.cancelled",
      projectKey: request.projectKey,
      requestId: request.id,
      actorId,
      payload: planEvent(snapshot.plan),
    });
    return { text: "已取消" };
  }

  /** Hands version files and notes to a Lody task through `/task`; at most once per version. */
  private async prepare(
    request: HarnessRequestRecord,
    snapshot: ReleaseSnapshot,
    callback: HarnessCallbackRequest,
  ): Promise<HarnessCallbackAnswer> {
    if (snapshot.plan.commitCount === 0) return { text: "没有新提交可发布" };
    if (snapshot.prepAt) return { text: "准备任务已派发" };
    const reply = await this.service.port.handleCommand({
      command: "task",
      args: prepInstruction(snapshot.plan),
      chatId: callback.chatId,
      threadId: callback.threadId,
      userId: callback.userId,
      messageId: callback.messageId,
    });
    // Like `/bug`, `/task` answers with an empty reply once it posted its own card; any text is
    // an error or usage message, so the preparation stays undispatched and may be retried.
    if (reply.html) {
      await this.service.telegram?.send(callback.chatId, {
        html: reply.html,
        keyboard: reply.keyboard,
        threadId: callback.threadId,
        replyToMessageId: callback.messageId,
      });
      return { text: "准备任务未派发，见话题中的回复" };
    }
    await this.publish(request, { ...snapshot, prepAt: this.service.now().toISOString() });
    await this.service.recordEvent({
      type: "release.prep_dispatched",
      projectKey: request.projectKey,
      requestId: request.id,
      actorId: callback.userId,
      payload: planEvent(snapshot.plan),
    });
    return { text: "已派发准备任务" };
  }

  /** Never tags a commit other than the one on screen, and never touches an existing tag. */
  private async confirm(
    approval: HarnessApprovalRecord,
    request: HarnessRequestRecord,
    snapshot: ReleaseSnapshot,
    actorId: number,
  ): Promise<HarnessCallbackAnswer> {
    const { service } = this;
    const { store } = service;
    const { plan } = snapshot;
    const github = this.work.github;
    const event = (type: string, payload: Record<string, unknown> = {}) =>
      service.recordEvent({
        type,
        projectKey: request.projectKey,
        requestId: request.id,
        approvalId: approval.id,
        actorId,
        payload: { ...planEvent(plan), ...payload },
      });
    const head = await github.getDefaultBranch(plan.repo);
    if (head.sha !== plan.targetSha) {
      await this.replan(
        request,
        snapshot,
        `${head.branch} 已前进到 ${short(head.sha)}，计划已刷新，请重新确认`,
      );
      await event("release.stale", { head: head.sha });
      return { text: "默认分支已更新，卡片已刷新，请重新确认", alert: true };
    }
    if (prepPending(snapshot)) {
      await this.publish(request, snapshot);
      return { text: PREP_PENDING, alert: true };
    }
    if (await github.releases.getTagRef(plan.repo, plan.tag)) {
      await this.publish(request, {
        ...snapshot,
        note: `tag ${plan.tag} 已存在，未重复创建；点「刷新」重新计算版本`,
      });
      await event("release.tag_exists");
      return { text: `tag ${plan.tag} 已存在，未创建`, alert: true };
    }
    if (!(await store.consumeApproval(approval.id, actorId, service.now()))) return consumed();
    let tagObject: string | null;
    try {
      ({ sha: tagObject } = await github.releases.createTag(plan.repo, {
        tag: plan.tag,
        sha: plan.targetSha,
        message: `Release ${plan.tag}`,
      }));
    } catch (error) {
      // A timeout or 5xx may still have created the ref, which was absent a moment ago.
      const status = httpStatus(error);
      const landed =
        (status === null || status >= 500) &&
        (await github.releases.getTagRef(plan.repo, plan.tag).catch(() => null));
      if (!landed || landed.sha !== plan.targetSha) {
        await this.publish(request, { ...snapshot, note: `创建 tag 失败：${errorText(error)}` });
        await event("release.tag_failed", { status });
        return { text: `创建 tag 失败：${errorText(error)}`, alert: true };
      }
      tagObject = null;
    }
    await store.transitionRequest(request.id, [R.planned], R.building, { stateReason: null });
    const fresh = (await store.getRequest(request.id))!;
    await store.invalidateApprovals(
      request.id,
      "tagged",
      service.now(),
      bindingOf(fresh),
      APPROVAL_ACTIONS.release,
    );
    await this.publish(fresh, { ...snapshot, taggedAt: service.now().toISOString(), note: null });
    await event("release.tagged", { tagObject, previous: plan.previous?.tag ?? null });
    this.nextPoll.set(request.id, service.now().getTime() + POLL_INTERVAL_MS);
    return { text: `已创建 tag ${plan.tag}` };
  }

  /** One read of the Release and the tag's workflow runs; the caller holds the request lock. */
  private async track(
    request: HarnessRequestRecord,
    snapshot: ReleaseSnapshot,
  ): Promise<HarnessCallbackAnswer> {
    if (!TRACKED.includes(request.state)) return consumed();
    const { service } = this;
    const { plan } = snapshot;
    const { releases } = this.work.github;
    const [release, runs] = await Promise.all([
      releases.getReleaseByTag(plan.repo, plan.tag),
      releases.listWorkflowRuns(plan.repo, plan.targetSha),
    ]);
    const taggedAt = snapshot.taggedAt ? new Date(snapshot.taggedAt) : request.updatedAt;
    const observed = observeRelease(snapshot, { release, runs, now: service.now() }, taggedAt);
    let current = request;
    if (observed.state !== request.state) {
      await service.store.transitionRequest(request.id, [request.state], observed.state);
      current = (await service.store.getRequest(request.id))!;
      await service.recordEvent({
        type: `release.${observed.state.replace(/^release_/, "")}`,
        projectKey: request.projectKey,
        requestId: request.id,
        payload: {
          ...planEvent(plan),
          runId: observed.snapshot.run?.id ?? null,
          conclusion: observed.snapshot.run?.conclusion ?? null,
        },
      });
    }
    await this.publish(current, observed.snapshot);
    return { text: "已刷新" };
  }

  /** Scheduler step: every building release is read at most once per interval. */
  async poll(): Promise<void> {
    const { service } = this;
    if (!service.github?.available) return;
    const building = await service.store.listRequestsByState([R.building]);
    const ids = new Set(building.map((request) => request.id));
    for (const id of this.nextPoll.keys()) if (!ids.has(id)) this.nextPoll.delete(id);
    const now = service.now().getTime();
    for (const request of building) {
      if ((this.nextPoll.get(request.id) ?? 0) > now) continue;
      this.nextPoll.set(request.id, now + POLL_INTERVAL_MS);
      await this.work
        .withRequest(request.id, async () => {
          const fresh = await service.store.getRequest(request.id);
          const snapshot = fresh?.state === R.building ? await this.load(fresh) : null;
          if (fresh && snapshot) await this.track(fresh, snapshot);
        })
        .catch((error) =>
          service.logger.warn(`Dev Harness release poll ${request.id}: ${errorText(error)}`),
        );
    }
  }
}

function consumed(): HarnessCallbackAnswer {
  return { text: APPROVAL_PROBLEM_TEXT.consumed };
}
