import { KeyedAsyncLock } from "../services/keyed-async-lock.js";
import { APPROVAL_ACTIONS, ensureCardApproval } from "./approvals.js";
import { publishCard } from "./card-publisher.js";
import { CiDetector, awaitRegistration } from "./ci-expectation.js";
import type { ProjectEffectiveConfig } from "./config/schema.js";
import { durationMs } from "./config/units.js";
import { evaluateContract, extractFirstImage, summarizeChecks } from "./contract.js";
import type { PullRequestInfo } from "./github.js";
import { acceptsPullRequest } from "./intake.js";
import { errorText } from "./pr-actions.js";
import { type PrCardInput, renderPrCard } from "./pr-card.js";
import { findLinkedRequest, openStateFor } from "./pr-link.js";
import { assessRisk } from "./risk.js";
import type { HarnessService } from "./service.js";
import { REQUEST_STATES as S, isOpenPrState } from "./states.js";
import type { HarnessRequestPatch, HarnessRequestRecord } from "./store.js";
import { summaryKey } from "./summary.js";

const OPEN_PR_STATE = S.open;
const CAPTION_LIMIT = 1024;
const CARD_PR_ACTIONS = new Set([
  "opened",
  "reopened",
  "ready_for_review",
  "converted_to_draft",
  "synchronize",
  "edited",
  "closed",
  "labeled",
]);

export interface SyncOptions {
  reason: string;
  pushedAt?: Date;
  bodyEditedAt?: Date;
  note?: string;
  confirmingMerge?: boolean;
  /** Renders the card expanded; any later sync without it collapses the card again. */
  expanded?: boolean;
}

type Payload = Record<string, unknown>;

function record(value: unknown): Payload {
  return typeof value === "object" && value !== null ? (value as Payload) : {};
}

function prNumbers(value: unknown): number[] {
  return Array.isArray(value)
    ? value.map((item) => record(item).number).filter((n): n is number => typeof n === "number")
    : [];
}

interface RegistrationWait {
  projectKey: string;
  number: number;
  at: Date;
}

export class HarnessPrFlow {
  readonly lock = new KeyedAsyncLock();
  private readonly ci = new CiDetector();
  /** PRs whose card shows 等待 CI 登记; the scheduler re-syncs them when the wait ends. */
  private readonly registrationWaits = new Map<string, RegistrationWait>();
  private readonly drafts = new Map<string, boolean>();

  constructor(private readonly service: HarnessService) {}

  private get github() {
    const github = this.service.github;
    if (!github?.available) throw new Error("GitHub App 未配置");
    return github;
  }

  project(projectKey: string): ProjectEffectiveConfig {
    const view = this.service.projectView(projectKey);
    if (!view) throw new Error(`项目 ${projectKey} 的配置无法解析`);
    return view.config;
  }

  async handleWebhookEvent(event: string, payload: Payload, projectKey: string): Promise<void> {
    const repo = this.project(projectKey).project.repo;
    const now = this.service.now();
    if (event === "pull_request") {
      const action = String(payload.action ?? "");
      const number = record(payload.pull_request).number;
      if (!CARD_PR_ACTIONS.has(action) || typeof number !== "number") return;
      const changes = record(payload.changes);
      if (action === "edited" && !changes.body && !changes.title) return;
      await this.sync(projectKey, number, {
        reason: `pull_request.${action}`,
        pushedAt: action === "synchronize" ? now : undefined,
        bodyEditedAt: action === "edited" && changes.body ? now : undefined,
      });
      return;
    }
    if (event === "check_run" || event === "check_suite" || event === "status") {
      // A created run only matters to a card still waiting for its first check.
      const registering = event === "check_run" && payload.action === "created";
      if (event !== "status" && payload.action !== "completed" && !registering) return;
      const source = record(payload[event]);
      const sha = String((event === "status" ? payload.sha : source.head_sha) ?? "");
      const numbers = new Set(prNumbers(source.pull_requests));
      if (sha) {
        for (const request of await this.service.store.findRequestsByHead(repo, sha)) {
          if (request.prNumber) numbers.add(request.prNumber);
        }
      }
      for (const number of numbers) {
        if (registering && !this.registrationWaits.has(prLockKey(repo, number))) continue;
        const tracked = await this.service.store.findRequestByPr(repo, number);
        if (tracked && isOpenPrState(tracked.state)) {
          await this.sync(projectKey, number, { reason: event });
        }
      }
      return;
    }
    if (event === "push") {
      const defaultBranch = record(payload.repository).default_branch;
      if (typeof defaultBranch === "string" && payload.ref === `refs/heads/${defaultBranch}`) {
        await this.service.refreshPolicy(projectKey);
      }
    }
  }

  sync(projectKey: string, number: number, options: SyncOptions): Promise<void> {
    const repo = this.project(projectKey).project.repo;
    return this.lock.run(prLockKey(repo, number), () =>
      this.syncUnlocked(projectKey, number, options),
    );
  }

  async evaluate(
    config: ProjectEffectiveConfig,
    pr: PullRequestInfo,
    request: HarnessRequestRecord,
  ) {
    const repo = config.project.repo;
    const [files, checkData, required] = await Promise.all([
      this.github.listPullRequestFiles(repo, pr.number),
      this.github.listChecks(repo, pr.headSha),
      config.github.requireChecks === "required"
        ? this.github.getRequiredChecks(repo, pr.baseRef)
        : Promise.resolve(null),
    ]);
    const summary = summarizeChecks(checkData.runs, checkData.statuses, required);
    const ci = config.github.ci;
    const now = this.service.now();
    const { checks, recheckAt } = awaitRegistration(summary, {
      expected:
        summary.state === "none" &&
        (await this.ci.expected(this.github, repo, pr.baseRef, durationMs(ci.detectTtl), now)),
      lastPushAt: request.lastPushAt,
      now,
      graceMs: durationMs(ci.grace),
      timeoutMs: durationMs(ci.registrationTimeout),
    });
    const risk = assessRisk(files, config.policy.risk);
    const contract = evaluateContract({
      policy: config.policy,
      body: pr.body,
      files,
      checks,
      bodyEditedAt: request.bodyEditedAt,
      lastPushAt: request.lastPushAt,
    });
    return { files, checks, risk, contract, recheckAt };
  }

  /** Last draft flag seen by a sync, so the job monitor can skip a GitHub read. */
  knownDraft(repo: string, number: number): boolean | undefined {
    return this.drafts.get(prLockKey(repo, number));
  }

  async resyncDue(): Promise<void> {
    const now = this.service.now();
    for (const [key, wait] of this.registrationWaits) {
      if (wait.at > now) continue;
      this.registrationWaits.delete(key);
      await this.sync(wait.projectKey, wait.number, { reason: "ci_registration" });
    }
  }

  private async summarize(
    config: ProjectEffectiveConfig,
    pr: PullRequestInfo,
    request: HarnessRequestRecord,
  ) {
    const key = summaryKey(pr.title, pr.body);
    if (request.summaryKey === key) return { summary: request.summary, summaryKey: key };
    let summary: string | null = null;
    if (config.telegram.cards.summary === "ai" && this.service.summarizer) {
      try {
        summary = await this.service.summarizer({ title: pr.title, body: pr.body });
      } catch (error) {
        this.service.logger.warn(`Dev Harness PR summary failed: ${errorText(error)}`);
      }
    }
    return { summary, summaryKey: key };
  }

  /** Caller must hold the PR lock. */
  async syncUnlocked(projectKey: string, number: number, options: SyncOptions) {
    const { service } = this;
    const config = this.project(projectKey);
    const repo = config.project.repo;
    const pr = await this.github.getPullRequest(repo, number);
    const now = service.now();
    let request = await service.store.findRequestByPr(repo, number);
    if (!request && pr.state === "open") {
      const linked = await findLinkedRequest(service.store, config, pr);
      if (linked) {
        const link = {
          prNumber: number,
          headSha: pr.headSha,
          bodyEditedAt: pr.createdAt,
          lastPushAt: pr.createdAt,
        };
        await service.store.updateRequest(linked.id, link);
        // Keep the pre-link head so linking counts as the session's first push.
        request = { ...linked, ...link, headSha: linked.headSha };
        await service.recordEvent({
          type: "pr.linked",
          projectKey,
          requestId: linked.id,
          payload: { number, branch: pr.headRef },
        });
      }
    }
    if (!request) {
      if (pr.state !== "open" || !acceptsPullRequest(config.github, repo, pr)) return;
      request = await service.store.insertRequest({
        projectKey,
        type: "pr",
        state: OPEN_PR_STATE,
        repo,
        prNumber: number,
        headSha: pr.headSha,
        title: pr.title,
        bodyEditedAt: pr.createdAt,
        lastPushAt: pr.createdAt,
      });
      await service.recordEvent({
        type: "pr.tracked",
        projectKey,
        requestId: request.id,
        payload: { number },
      });
    }

    const patch: HarnessRequestPatch = { title: pr.title };
    if (options.bodyEditedAt) patch.bodyEditedAt = options.bodyEditedAt;
    if (options.pushedAt) patch.lastPushAt = options.pushedAt;
    const headChanged = request.headSha !== pr.headSha;
    if (headChanged) {
      patch.headSha = pr.headSha;
      patch.lastPushAt ??= now;
      const invalidated = await service.store.invalidateApprovals(
        request.id,
        "new_push",
        now,
        pr.headSha,
        APPROVAL_ACTIONS.merge,
      );
      await service.recordEvent({
        type: "pr.head_changed",
        projectKey,
        requestId: request.id,
        payload: { from: request.headSha, to: pr.headSha, invalidated },
      });
    }
    const state = pr.merged
      ? S.merged
      : pr.state === "closed"
        ? S.closed
        : openStateFor(request, headChanged);
    const open = isOpenPrState(state);
    if (!open) await service.store.invalidateApprovals(request.id, state, now);
    patch.state = state;
    if (state === S.prReady && request.state !== S.prReady) patch.stateReason = null;
    let current: HarnessRequestRecord = { ...request, ...patch };

    const evaluation = await this.evaluate(config, pr, current);
    const key = prLockKey(repo, number);
    if (pr.state === "open") this.drafts.set(key, pr.draft);
    else this.drafts.delete(key);
    if (evaluation.recheckAt && pr.state === "open") {
      this.registrationWaits.set(key, { projectKey, number, at: evaluation.recheckAt });
    } else {
      this.registrationWaits.delete(key);
    }
    Object.assign(patch, await this.summarize(config, pr, current));
    Object.assign(patch, await service.work.onPrSync(current, pr, evaluation.checks));
    current = { ...current, ...patch };
    const approval = isOpenPrState(current.state)
      ? await ensureCardApproval(service.store, current, pr.headSha, config.approvals.ttl, now)
      : null;
    const cardInput: PrCardInput = {
      repo,
      number,
      title: pr.title,
      url: pr.htmlUrl,
      author: pr.author,
      state: pr.state,
      merged: pr.merged,
      draft: pr.draft,
      tier: evaluation.risk.tier,
      summary: patch.summary ?? null,
      checks: evaluation.checks,
      contract: evaluation.contract,
      approvalId: approval?.id ?? null,
      confirmingMerge: options.confirmingMerge,
      details:
        options.expanded || options.confirmingMerge ? { files: evaluation.risk.files } : null,
      imageUrl: config.telegram.cards.screenshot === "first" ? extractFirstImage(pr.body) : null,
      note: options.note ?? stageNote(current),
      footer: await service.work.footerFor(current, config),
    };
    patch.riskTier = evaluation.risk.tier;
    Object.assign(patch, await this.publish(projectKey, current, cardInput));
    await service.store.updateRequest(request.id, patch);
  }

  private async publish(projectKey: string, request: HarnessRequestRecord, input: PrCardInput) {
    const wantsPhoto =
      request.cardMessageId !== null ? request.cardKind === "photo" : input.imageUrl !== null;
    let card = renderPrCard(input);
    if (wantsPhoto && card.html.length > CAPTION_LIMIT) {
      const compact: PrCardInput = {
        ...input,
        summary: null,
        note: undefined,
        footer: null,
        contract: { ...input.contract, missing: [], flags: [] },
      };
      for (const maxFiles of [5, 0]) {
        card = renderPrCard({
          ...compact,
          details: input.details ? { ...input.details, maxFiles } : null,
        });
        if (card.html.length <= CAPTION_LIMIT || !input.details) break;
      }
    }
    return publishCard(this.service, projectKey, request, card);
  }
}

export function prLockKey(repo: string, number: number): string {
  return `${repo.toLowerCase()}#${number}`;
}

function stageNote(request: HarnessRequestRecord): string | undefined {
  if (request.state === S.revising) return "✏️ 修订中";
  if (request.state === S.needsAttention) {
    return `👀 需要你看一下${request.stateReason ? `：${request.stateReason}` : ""}`;
  }
  if (request.state === S.cancelled) return "⚫ 请求已取消，harness 不再跟进";
  return undefined;
}
