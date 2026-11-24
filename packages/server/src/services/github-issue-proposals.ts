import type { Database } from "@cos-tool-bot/database";
import { bots } from "@cos-tool-bot/database";
import { GitHubClient, type GitHubIssue } from "@cos-tool-bot/bot";
import type {
  GitHubIssueProposal,
  GitHubIssueProposalActor,
  GitHubIssueProposalPort,
  GitHubToolsConfigStored,
} from "@cos-tool-bot/shared";
import { eq } from "drizzle-orm";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { z } from "zod";
import { tryDecrypt } from "../utils/crypto.js";
import type { GitHubAppCredentialService } from "./github-app-credentials.js";
import type { GitHubIssueProposalStore } from "./github-issue-proposal-store.js";

const descriptorSchema = z.object({
  id: z.string().regex(/^[\da-f]{24}$/),
  botId: z.string().uuid(),
  chatId: z.number().int().safe(),
  threadId: z.number().int().positive().nullable(),
  initiator: z.number().int().positive().safe(),
  repository: z.string().regex(/^[a-z\d_.-]+\/[a-z\d_.-]+$/),
  title: z.string().min(1).max(256),
  body: z.string().max(65_536),
  createdAt: z.number().int().nonnegative().safe(),
  expiresAt: z.number().int().nonnegative().safe().nullable(),
});
const proposalSchema = descriptorSchema
  .extend({
    hash: z.string().regex(/^[\da-f]{64}$/),
    status: z.enum([
      "pending",
      "executing",
      "completed",
      "cancelled",
      "expired",
      "superseded",
      "result_unknown",
      "not_executed",
    ]),
    executionOwner: z.string().optional(),
    executionPhase: z.enum(["authorizing", "posting"]).optional(),
    result: z.object({ summary: z.string(), url: z.string() }).optional(),
  })
  .strict();
type StoredProposal = z.infer<typeof proposalSchema>;
type Descriptor = z.infer<typeof descriptorSchema>;

function digest(proposal: Descriptor) {
  return createHash("sha256")
    .update(JSON.stringify(descriptorSchema.parse(proposal)))
    .digest("hex");
}
function decode(value: string): StoredProposal {
  try {
    const proposal = proposalSchema.parse(JSON.parse(value));
    if (digest(proposal) !== proposal.hash) throw new Error();
    return proposal;
  } catch {
    // Parser diagnostics may quote the retained body or arbitrary record keys.
    throw new Error("GitHub 提案记录校验失败，无法确认");
  }
}
function marker(proposal: GitHubIssueProposal) {
  return `<!-- cos-tool-bot:github-issue:v1:${proposal.id}:${proposal.hash} -->`;
}
function issueBody(proposal: GitHubIssueProposal) {
  return `${proposal.body}\n\n${marker(proposal)}`;
}
function result(proposal: GitHubIssueProposal, issue: GitHubIssue) {
  const url = `https://github.com/${proposal.repository}/issues/${issue.number}`;
  if (
    !Number.isSafeInteger(issue.number) ||
    issue.number <= 0 ||
    issue.pull_request ||
    issue.title !== proposal.title ||
    issue.body !== issueBody(proposal) ||
    issue.html_url?.toLowerCase() !== url.toLowerCase()
  ) {
    throw new Error("GitHub 未返回可验证的 Issue；结果未知，请核实");
  }
  return {
    summary: `已创建 ${proposal.repository}#${issue.number}：${issue.title}`,
    url: issue.html_url,
  };
}

export interface GitHubIssueProposalAuthorization {
  config: GitHubToolsConfigStored;
  token: string;
}
export type AuthorizeGitHubIssueProposal = (
  botId: string,
  userId: number,
  repository?: string,
) => Promise<GitHubIssueProposalAuthorization>;

/** Every call reads the current tenant, administrator list, repository scope and credential. */
export function createGitHubIssueProposalAuthorizer(
  db: Database,
  encryptionKey: string,
  getAppService: () => GitHubAppCredentialService | undefined,
): AuthorizeGitHubIssueProposal {
  return async (botId, userId, repository) => {
    const [bot] = await db
      .select({ active: bots.isActive, admins: bots.adminChatIds, ai: bots.aiConfig })
      .from(bots)
      .where(eq(bots.id, botId));
    const config = bot?.ai?.githubToolsConfig;
    if (!bot?.active || !bot.ai?.enabled || !bot.admins.includes(userId) || !config?.enabled) {
      throw new Error("当前身份不是已启用 Bot 的管理员，或 GitHub 工具已关闭");
    }
    const installation = config.githubAppInstallation;
    const allowed = installation?.repositories ?? config.repositories;
    if (repository && !allowed.some((repo) => repo.toLowerCase() === repository.toLowerCase())) {
      throw new Error("仓库不在当前 GitHub 授权范围内");
    }
    const snapshot = JSON.stringify(bot);
    const app = getAppService();
    // An installed App is the authority: never fall back to an unrelated legacy identity.
    const token = installation
      ? app?.available
        ? await app.getInstallationToken(installation.installationId)
        : undefined
      : config.encryptedToken
        ? tryDecrypt(config.encryptedToken, encryptionKey)
        : undefined;
    if (!token) throw new Error("当前 GitHub 凭据不可用");
    const [latest] = await db
      .select({ active: bots.isActive, admins: bots.adminChatIds, ai: bots.aiConfig })
      .from(bots)
      .where(eq(bots.id, botId));
    if (JSON.stringify(latest) !== snapshot) throw new Error("GitHub 当前授权已变更，请重新确认");
    return { config, token };
  };
}

// Service instances in one process share liveness; the persisted phase fences abandoned claims.
const activeExecutions = new Map<string, number>();

export class GitHubIssueProposalService {
  constructor(
    private readonly store: GitHubIssueProposalStore,
    private readonly authorize: AuthorizeGitHubIssueProposal,
    private readonly fetchImpl?: typeof fetch,
    private readonly now = Date.now,
  ) {}

  forBot(botId: string): GitHubIssueProposalPort {
    return {
      propose: (input) => this.propose(botId, input),
      list: (actor) => this.list(botId, actor),
      decide: (id, actor, decision) => this.decide(botId, id, actor, decision),
    };
  }

  private async propose(botId: string, input: Parameters<GitHubIssueProposalPort["propose"]>[0]) {
    const repository = input.repository.toLowerCase();
    const { config } = await this.authorize(botId, input.userId, repository);
    const ttl = config.createIssueConfirmationTtlMinutes ?? null;
    if (ttl !== null && (!Number.isSafeInteger(ttl) || ttl <= 0)) {
      throw new Error("Issue 确认有效期配置无效");
    }
    const createdAt = this.now();
    const expiresAt = ttl === null ? null : createdAt + ttl * 60_000;
    if (
      expiresAt !== null &&
      (!Number.isSafeInteger(expiresAt) || !Number.isFinite(new Date(expiresAt).getTime()))
    ) {
      throw new Error("Issue 确认到期时间超出可表示的日期范围");
    }
    const descriptor = descriptorSchema.parse({
      id: randomBytes(12).toString("hex"),
      botId,
      repository,
      chatId: input.chatId,
      threadId: input.threadId ?? null,
      initiator: input.userId,
      title: input.title,
      body: input.body ?? "",
      createdAt,
      expiresAt,
    });
    const proposal: StoredProposal = { ...descriptor, hash: digest(descriptor), status: "pending" };
    if (issueBody(proposal).length > 65_536)
      throw new Error("Issue 正文过长，需为提案核实标记预留空间");
    await this.store.insert(botId, proposal.id, JSON.stringify(proposal));
    return proposal;
  }

  private matches(proposal: GitHubIssueProposal, actor: GitHubIssueProposalActor) {
    if (proposal.initiator !== actor.userId) {
      throw new Error("只有发起该提案的管理员可以操作，请使用发起提案时的 Telegram 账号");
    }
    if (proposal.chatId !== actor.chatId) {
      throw new Error("请回到发起该提案的原聊天操作");
    }
    if (proposal.threadId !== (actor.threadId ?? null)) {
      throw new Error(
        "提案话题不匹配，请回到发起提案的原话题操作；普通群的旧确认卡可能绑定了旧回复串",
      );
    }
  }

  private async refresh(
    botId: string,
    id: string,
  ): Promise<{ proposal: StoredProposal; value: string }> {
    const value = await this.store.get(botId, id);
    if (value === undefined) throw new Error("GitHub 提案不存在或已处理");
    const proposal = decode(value);
    if (proposal.botId !== botId || proposal.id !== id) throw new Error("GitHub 提案归属校验失败");
    const status =
      proposal.status === "pending" &&
      proposal.expiresAt !== null &&
      this.now() >= proposal.expiresAt
        ? "expired"
        : proposal.status === "executing" &&
            !activeExecutions.has(`${proposal.executionOwner}:${botId}:${id}`)
          ? proposal.executionPhase === "authorizing"
            ? "not_executed"
            : "result_unknown"
          : proposal.status;
    if (status !== proposal.status) {
      const next = { ...proposal, status };
      const nextValue = JSON.stringify(next);
      if (await this.store.compareExchange(botId, id, value, nextValue))
        return { proposal: next, value: nextValue };
      return this.refresh(botId, id);
    }
    return { proposal, value };
  }

  private async list(botId: string, actor: GitHubIssueProposalActor) {
    await this.authorize(botId, actor.userId);
    const proposals: GitHubIssueProposal[] = [];
    for (const value of await this.store.list(botId)) {
      const entry = decode(value);
      if (
        entry.botId !== botId ||
        entry.initiator !== actor.userId ||
        entry.chatId !== actor.chatId ||
        entry.threadId !== (actor.threadId ?? null)
      )
        continue;
      const { proposal } = await this.refresh(botId, entry.id);
      if (["pending", "executing", "result_unknown"].includes(proposal.status))
        proposals.push(proposal);
    }
    return proposals.sort((a, b) => b.createdAt - a.createdAt);
  }

  private async decide(
    botId: string,
    id: string,
    actor: GitHubIssueProposalActor,
    decision: "confirm" | "cancel" | "verify",
  ) {
    if (!/^[\da-f]{24}$/.test(id)) throw new Error("GitHub 提案 ID 无效");
    const { proposal, value } = await this.refresh(botId, id);
    this.matches(proposal, actor);
    const auth = await this.authorize(botId, actor.userId, proposal.repository);
    const latest = await this.refresh(botId, id);
    if (latest.value !== value) return latest.proposal;
    const client = new GitHubClient({ token: auth.token, fetch: this.fetchImpl });
    if (proposal.status === "result_unknown") {
      if (decision === "cancel") throw new Error("操作可能已执行，不能撤回；请核实结果");
      return this.verify(proposal, value, client);
    }
    if (proposal.status !== "pending" || decision === "verify") return proposal;
    const executionOwner = randomUUID();
    const claimed: StoredProposal = {
      ...proposal,
      status: decision === "cancel" ? "cancelled" : "executing",
      ...(decision === "confirm" ? { executionOwner, executionPhase: "authorizing" as const } : {}),
    };
    const claimedValue = JSON.stringify(claimed);
    const executionKey = `${executionOwner}:${botId}:${id}`;
    if (decision === "confirm")
      activeExecutions.set(executionKey, (activeExecutions.get(executionKey) ?? 0) + 1);
    let requestStarted = false;
    let executionValue = claimedValue;
    try {
      if (!(await this.store.compareExchange(botId, id, value, claimedValue)))
        return (await this.refresh(botId, id)).proposal;
      if (decision === "cancel") return claimed;
      // Re-read after claim as well: credential resolution and DB contention can take time.
      const current = await this.authorize(botId, actor.userId, proposal.repository);
      if (proposal.expiresAt !== null && this.now() >= proposal.expiresAt) {
        const expired: StoredProposal = { ...claimed, status: "expired" };
        await this.store.compareExchange(botId, id, claimedValue, JSON.stringify(expired));
        return (await this.refresh(botId, id)).proposal;
      }
      const posting: StoredProposal = { ...claimed, executionPhase: "posting" };
      executionValue = JSON.stringify(posting);
      // A restart/another process may have retired the pre-POST claim. Fence before dispatch.
      if (!(await this.store.compareExchange(botId, id, claimedValue, executionValue)))
        return (await this.refresh(botId, id)).proposal;
      requestStarted = true;
      const issue = await new GitHubClient({
        token: current.token,
        fetch: this.fetchImpl,
      }).createIssue(proposal.repository, { title: proposal.title, body: issueBody(proposal) });
      const completed: StoredProposal = {
        ...claimed,
        executionPhase: "posting",
        status: "completed",
        result: result(proposal, issue),
      };
      if (
        !(await this.store.compareExchange(botId, id, executionValue, JSON.stringify(completed)))
      ) {
        return (await this.refresh(botId, id)).proposal;
      }
      return completed;
    } catch {
      if (!requestStarted) {
        // Only this invocation's pre-POST claim can be retired. A failed concurrent
        // cancellation or confirmation must not overwrite another invocation's progress.
        if (decision === "confirm") {
          const notExecuted: StoredProposal = { ...claimed, status: "not_executed" };
          await this.store.compareExchange(botId, id, claimedValue, JSON.stringify(notExecuted));
        }
        return (await this.refresh(botId, id)).proposal;
      }
      // Even failed receipts/persistence can hide a successful POST. Never make it pending again.
      const unknown: StoredProposal = {
        ...claimed,
        executionPhase: "posting",
        status: "result_unknown",
      };
      await this.store.compareExchange(botId, id, executionValue, JSON.stringify(unknown));
      return (await this.refresh(botId, id)).proposal;
    } finally {
      if (decision === "confirm") {
        const remaining = (activeExecutions.get(executionKey) ?? 1) - 1;
        if (remaining === 0) activeExecutions.delete(executionKey);
        else activeExecutions.set(executionKey, remaining);
      }
    }
  }

  private async verify(proposal: StoredProposal, value: string, client: GitHubClient) {
    try {
      const issue = await client.findIssueByProposal(
        proposal.repository,
        proposal.title,
        issueBody(proposal),
      );
      if (!issue) return proposal;
      const completed: StoredProposal = {
        ...proposal,
        status: "completed",
        result: result(proposal, issue),
      };
      if (
        await this.store.compareExchange(
          proposal.botId,
          proposal.id,
          value,
          JSON.stringify(completed),
        )
      )
        return completed;
      return (await this.refresh(proposal.botId, proposal.id)).proposal;
    } catch {
      return proposal;
    }
  }
}
