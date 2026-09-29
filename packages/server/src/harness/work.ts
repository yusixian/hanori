import { randomUUID } from "node:crypto";
import { KeyedAsyncLock } from "../services/keyed-async-lock.js";
import { APPROVAL_ACTIONS, ensureApproval, jobBinding } from "./approvals.js";
import { publishCard } from "./card-publisher.js";
import type { ProjectEffectiveConfig } from "./config/schema.js";
import type { CheckSummary } from "./contract.js";
import type { PullRequestInfo } from "./github.js";
import { issueUrl, renderJobCard, sessionLink } from "./job-card.js";
import type { LodyResult } from "./lody.js";
import type { TurnEnd, TurnStatus } from "./lody-wait.js";
import { errorText } from "./pr-actions.js";
import type { PrSessionControls } from "./pr-card.js";
import { type PromptInput, type PromptKind, buildPrompt, harnessBranch } from "./prompts.js";
import { renderFooter } from "./quota.js";
import { handleTurnEnd } from "./job-monitor.js";
import { HarnessScheduler } from "./scheduler.js";
import type { HarnessService } from "./service.js";
import {
  JOB_STATES,
  LIVE_JOB_STATES,
  REQUEST_STATES as S,
  TERMINAL_STATES,
  isTerminal,
  isWorkRequest,
} from "./states.js";
import type { HarnessRequestPatch, HarnessRequestRecord } from "./store.js";
import type { HarnessJobRecord } from "./work-store.js";

/** Marks comments the harness posts itself, so they are never parsed as protocol lines. */
export const RELAY_MARKER = "<!-- dev-harness:relay -->";

const MAX_TURN_ENDS = 500;

/** A work request's part in a PR sync; `state` replaces the one the PR implies. */
export interface PrSyncFollowUp {
  state?: string;
  fields?: HarnessRequestPatch;
  apply?: () => Promise<void>;
}

/** Execution side of the harness: sessions, job cards, prompts, and PR follow-ups. */
export class HarnessWork {
  /** Per-request lock (`req:<id>`) for job actions, scheduling, and polling. */
  readonly lock = new KeyedAsyncLock();
  readonly scheduler: HarnessScheduler;
  private readonly templateCache = new Map<string, string | null>();
  /**
   * Sessions whose last harness-started turn reported its end (bridge callback or local waiter).
   * In memory only: after a restart the delivery watch falls back to its polling debounce.
   */
  private readonly turnEnds = new Map<
    string,
    { at: number; status: TurnStatus | null; turnId?: string }
  >();

  constructor(readonly service: HarnessService) {
    this.scheduler = new HarnessScheduler(this);
  }

  config(projectKey: string): ProjectEffectiveConfig | null {
    return this.service.projectView(projectKey)?.config ?? null;
  }

  requireConfig(projectKey: string): ProjectEffectiveConfig {
    const config = this.config(projectKey);
    if (!config) throw new Error(`项目 ${projectKey} 的配置无法解析`);
    return config;
  }

  get github() {
    const github = this.service.github;
    if (!github?.available) throw new Error("GitHub App 未配置");
    return github;
  }

  withRequest<T>(requestId: string, operation: () => Promise<T>): Promise<T> {
    return this.lock.run(`req:${requestId}`, operation);
  }

  /** A reported turn end makes an idle session authoritative: no two-poll debounce. */
  turnEnded(sessionId: string): boolean {
    return this.turnStatus(sessionId) === "completed";
  }

  turnStatus(sessionId: string): TurnStatus | null {
    return this.turnEnds.get(sessionId)?.status ?? null;
  }

  markTurnEnded(sessionId: string, status: TurnStatus, turnId?: string): boolean {
    const expected = this.turnEnds.get(sessionId)?.turnId;
    // Match the dispatched turn, independent of the bridge's clock. Older bridges use polling.
    if (expected && turnId !== expected) return false;
    this.rememberTurn(sessionId, { at: this.service.now().getTime(), status, turnId });
    return true;
  }

  private rememberTurn(
    sessionId: string,
    turn: { at: number; status: TurnStatus | null; turnId?: string },
  ) {
    this.turnEnds.delete(sessionId);
    this.turnEnds.set(sessionId, turn);
    if (this.turnEnds.size > MAX_TURN_ENDS)
      this.turnEnds.delete(this.turnEnds.keys().next().value!);
  }

  /** A new turn began; `olderThanMs` spares an end that Lody's status has not caught up with. */
  clearTurnEnd(sessionId: string, olderThanMs = 0): void {
    const turn = this.turnEnds.get(sessionId);
    if (turn && this.service.now().getTime() - turn.at >= olderThanMs) {
      turn.status = null;
    }
  }

  onTurnEnd(end: TurnEnd): Promise<void> {
    return handleTurnEnd(this, end);
  }

  machineLabel(config: ProjectEffectiveConfig, job: HarnessJobRecord): string {
    return config.machines[job.machineKey]?.lody ?? job.lodyMachine;
  }

  async footerFor(request: HarnessRequestRecord, config: ProjectEffectiveConfig) {
    if (!isWorkRequest(request)) return null;
    const job = await this.service.store.latestJob(request.id);
    return job?.sessionId ? renderFooter(job, config.telegram.cards) : null;
  }

  /** The PR card's session row shares the job card's approval, so both cards act on one attempt. */
  async prControls(
    request: HarnessRequestRecord,
    config: ProjectEffectiveConfig,
    confirmingCancel = false,
  ): Promise<PrSessionControls | null> {
    if (!isWorkRequest(request) || isTerminal(request.state)) return null;
    const { service } = this;
    const job = await service.store.latestJob(request.id);
    const approval = await ensureApproval(service.store, request, {
      action: APPROVAL_ACTIONS.job,
      binding: jobBinding(request, job?.sessionId),
      ttl: config.approvals.ttl,
      now: service.now(),
    });
    const running = job?.state === JOB_STATES.running;
    return {
      approvalId: approval.id,
      canReject: running,
      canRequeue: !running && request.state === S.needsAttention,
      sessionUrl: sessionLink(config.executors.lody.sessionUrl, job?.sessionId ?? null),
      confirmingCancel,
    };
  }

  /** Renders the in-progress card; once a PR is linked, the PR card owns the message. */
  async refreshCard(
    request: HarnessRequestRecord,
    options: { replyToMessageId?: number } = {},
  ): Promise<void> {
    const { service } = this;
    const config = this.config(request.projectKey);
    if (!config || !service.telegram) return;
    if (request.prNumber) {
      await service.prFlow.sync(request.projectKey, request.prNumber, { reason: "job" });
      return;
    }
    const now = service.now();
    const job = await service.store.latestJob(request.id);
    const approval = isTerminal(request.state)
      ? null
      : await ensureApproval(service.store, request, {
          action: APPROVAL_ACTIONS.job,
          binding: jobBinding(request, job?.sessionId),
          ttl: config.approvals.ttl,
          now,
        });
    const card = renderJobCard({
      request,
      job,
      machineLabel: job ? this.machineLabel(config, job) : null,
      now,
      cards: config.telegram.cards,
      approvalId: approval?.id ?? null,
      sessionUrl: config.executors.lody.sessionUrl,
      queuedSince: request.state === S.queued ? await this.scheduler.queue.since(request) : null,
    });
    const patch = await publishCard(
      service,
      request.projectKey,
      request,
      { ...card, imageUrl: null },
      options,
    );
    if (Object.keys(patch).length > 0) await service.store.updateRequest(request.id, patch);
  }

  async defaultBranch(config: ProjectEffectiveConfig): Promise<{ branch: string; sha: string }> {
    return this.github.getDefaultBranch(config.project.repo);
  }

  /** Repo template overrides are read from the default branch head only. */
  private async taskTemplate(
    config: ProjectEffectiveConfig,
    kind: PromptKind,
    head: { sha: string },
  ): Promise<string | null> {
    const path = config.policy.prompts.templates[kind];
    if (!path) return null;
    const key = `${config.project.repo}@${head.sha}:${path}`;
    if (!this.templateCache.has(key)) {
      try {
        this.templateCache.set(key, await this.github.getFile(config.project.repo, path, head.sha));
      } catch (error) {
        this.service.logger.warn(`Dev Harness template ${path} not read: ${errorText(error)}`);
        return null;
      }
    }
    return this.templateCache.get(key) ?? null;
  }

  async prompt(
    request: HarnessRequestRecord,
    kind: PromptKind,
    extra: Partial<Pick<PromptInput, "ownerText" | "failures" | "round" | "lead">> = {},
  ): Promise<string> {
    const config = this.requireConfig(request.projectKey);
    const head = await this.defaultBranch(config);
    const repo = config.project.repo;
    return buildPrompt(config, {
      kind,
      requestId: request.id,
      branch: harnessBranch(config.github.branchPrefix, request.id),
      defaultBranch: head.branch,
      issue: request.issueNumber
        ? {
            number: request.issueNumber,
            url: issueUrl(repo, request.issueNumber),
            title: request.title ?? "",
          }
        : null,
      pr: request.prNumber
        ? { number: request.prNumber, url: `https://github.com/${repo}/pull/${request.prNumber}` }
        : null,
      ownerText: extra.ownerText ?? null,
      requestType: request.type === "task" ? "task" : "bug",
      failures: extra.failures,
      round: extra.round,
      lead: extra.lead,
      taskTemplate: await this.taskTemplate(config, kind, head),
    });
  }

  /** Sends a follow-up turn to the request's live session. */
  async sendToSession(
    request: HarnessRequestRecord,
    kind: PromptKind,
    extra: Partial<Pick<PromptInput, "ownerText" | "failures" | "round">> = {},
  ): Promise<LodyResult<void>> {
    const job = await this.service.store.latestJob(request.id);
    if (!job?.sessionId || job.state !== JOB_STATES.running) {
      return { ok: false, reason: "failed", message: "没有运行中的会话" };
    }
    const prompt = await this.prompt(request, kind, extra);
    const now = this.service.now().getTime();
    const turnId = randomUUID();
    this.rememberTurn(job.sessionId, { at: now, status: null, turnId });
    const result = await this.service.lody().chat(job.sessionId, prompt, turnId);
    await this.service.recordEvent({
      type: result.ok ? "session.chat" : "session.chat_failed",
      projectKey: request.projectKey,
      requestId: request.id,
      payload: { kind, ...(result.ok ? {} : { message: result.message }) },
    });
    if (result.ok) {
      await this.service.store.updateJob(job.id, {
        lastActivityAt: this.service.now(),
        nextPollAt: this.service.now(),
      });
    }
    return result;
  }

  /** Caller holds the request lock. The session turn is cancelled; the session itself is kept. */
  async cancel(request: HarnessRequestRecord, actorId: number | null, reason: string) {
    const { service } = this;
    const now = service.now();
    const job = await service.store.latestJob(request.id);
    let note = reason;
    if (job?.sessionId && job.state === JOB_STATES.running) {
      const result = await service.lody().cancelSession(job.sessionId);
      if (!result.ok) note = `${reason}（Lody 取消失败：${result.message}）`;
    }
    const nonTerminal = Object.values(S).filter((state) => !isTerminal(state));
    const moved = await service.store.transitionRequest(request.id, nonTerminal, S.cancelled, {
      stateReason: note,
    });
    if (!moved) return false;
    if (job && (LIVE_JOB_STATES as readonly string[]).includes(job.state)) {
      await service.store.updateJob(job.id, {
        state: JOB_STATES.cancelled,
        endedAt: now,
        leaseUntil: null,
      });
    }
    await service.store.invalidateApprovals(request.id, "cancelled", now);
    await service.recordEvent({
      type: "request.cancelled",
      projectKey: request.projectKey,
      requestId: request.id,
      actorId,
      payload: { reason: note },
    });
    const fresh = await service.store.getRequest(request.id);
    if (fresh) await this.refreshCard(fresh);
    return true;
  }

  /**
   * Called inside the PR sync (PR lock held) with the state the PR implies. Returns what the sync's
   * guarded write also carries, and in `apply` the session side (archiving, or the next CI auto-fix
   * round), which the sync runs only once that write won. Must not call back into the PR flow.
   */
  async onPrSync(
    request: HarnessRequestRecord,
    pr: PullRequestInfo,
    checks: CheckSummary,
  ): Promise<PrSyncFollowUp> {
    if (!isWorkRequest(request)) return {};
    const { service } = this;
    if ((TERMINAL_STATES as readonly string[]).includes(request.state)) {
      return request.state === S.cancelled ? {} : { apply: () => this.archiveSession(request.id) };
    }
    if (checks.state !== "failure" || request.lastFixSha === pr.headSha) return {};
    const job = await service.store.latestJob(request.id);
    if (!job?.sessionId || job.state !== JOB_STATES.running) return {};
    const config = this.requireConfig(request.projectKey);
    const max = config.guardrails.autoFixRounds;
    if (request.fixRounds >= max) {
      return {
        state: S.needsAttention,
        fields: { stateReason: `CI 连续失败 ${request.fixRounds} 轮`, lastFixSha: pr.headSha },
        apply: () =>
          service.recordEvent({
            type: "autofix.exhausted",
            projectKey: request.projectKey,
            requestId: request.id,
            payload: { rounds: request.fixRounds, sha: pr.headSha },
          }),
      };
    }
    const round = request.fixRounds + 1;
    return {
      apply: async () => {
        const sent = await this.sendToSession(request, "ci_failed", {
          failures: checks.failedNames,
          round,
        });
        await service.recordEvent({
          type: "autofix.sent",
          projectKey: request.projectKey,
          requestId: request.id,
          payload: { round, sha: pr.headSha, ok: sent.ok },
        });
        if (sent.ok) {
          await service.store.updateRequest(request.id, {
            fixRounds: round,
            lastFixSha: pr.headSha,
          });
        }
      },
    };
  }

  private async archiveSession(requestId: string) {
    const { service } = this;
    const job = await service.store.latestJob(requestId);
    if (!job?.sessionId || job.state !== JOB_STATES.running) return;
    const archived = await service.lody().archiveSession(job.sessionId);
    await service.store.updateJob(job.id, {
      state: JOB_STATES.done,
      endedAt: service.now(),
      ...(archived.ok ? {} : { error: `归档失败：${archived.message}` }),
    });
  }
}
