import type {
  HarnessEditMessage,
  HarnessKeyboard,
  HarnessMessageKind,
  HarnessOutgoingMessage,
  HarnessTelegram,
} from "@cos-tool-bot/bot";
import { validateHarnessConfig } from "./config/loader.js";
import type { AgentConfigInfo } from "./config/execution.js";
import type { CheckRunInput, CommitStatusInput } from "./contract.js";
import type {
  AccessibleRepository,
  CommitSummary,
  DirectoryEntry,
  HarnessGitHub,
  IssueDetail,
  IssueSummary,
  PullRequestInfo,
  PullRequestSummary,
} from "./github.js";
import { readFileSync } from "node:fs";
import {
  type CreateSessionInput,
  type LodyCli,
  type LodySession,
  extractJson,
  parseMachineList,
} from "./lody.js";
import { MemoryHarnessStore } from "./memory-store.js";
import { FakeReleaseGitHub } from "./release-test-fakes.js";
import type { ChangedFile } from "./risk.js";
import { HarnessService } from "./service.js";
import type { PrSummarizer } from "./summary.js";

export const TEST_CHAT_ID = -1001234567890;
export const TEST_OWNER = 42;
export const TEST_REPO = "example-owner/harness-sandbox";

export function testConfigRaw(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    version: 1,
    telegram: { bot: "example-dev", chatId: TEST_CHAT_ID, owners: [TEST_OWNER] },
    projects: { sandbox: { repo: TEST_REPO } },
    ...extra,
  };
}

export class FakeTelegram implements HarnessTelegram {
  readonly sent: Array<{ messageId: number; message: HarnessOutgoingMessage }> = [];
  readonly edits: Array<{
    messageId: number;
    kind: HarnessMessageKind;
    message: HarnessEditMessage;
  }> = [];
  readonly topics: string[] = [];
  readonly documents: string[] = [];
  private nextId = 100;

  async send(_chatId: number, message: HarnessOutgoingMessage) {
    const messageId = this.nextId++;
    this.sent.push({ messageId, message });
    return { messageId, kind: message.photoUrl ? ("photo" as const) : ("text" as const) };
  }

  async edit(
    _chatId: number,
    messageId: number,
    kind: HarnessMessageKind,
    message: HarnessEditMessage,
  ) {
    this.edits.push({ messageId, kind, message });
    return "edited" as const;
  }

  readonly keyboardEdits: Array<{ messageId: number; keyboard: HarnessKeyboard }> = [];

  async editKeyboard(_chatId: number, messageId: number, keyboard: HarnessKeyboard) {
    this.keyboardEdits.push({ messageId, keyboard });
    return "edited" as const;
  }

  async sendDocument(_chatId: number, document: { filename: string }) {
    this.documents.push(document.filename);
  }

  async createForumTopic(_chatId: number, name: string) {
    this.topics.push(name);
    return 500 + this.topics.length;
  }

  async setChatCommands() {}

  readonly files = new Map<string, Buffer>();
  readonly downloads: string[] = [];

  async downloadFile(fileId: string, maxBytes: number) {
    this.downloads.push(fileId);
    const bytes = this.files.get(fileId);
    return bytes && bytes.length <= maxBytes ? bytes : null;
  }

  lastCard() {
    return this.edits.at(-1)?.message ?? this.sent.at(-1)?.message;
  }

  callbackData(text: string): string | undefined {
    return this.lastCard()
      ?.keyboard?.flat()
      .find((button) => button.text.startsWith(text))?.callbackData;
  }
}

export class FakeGitHub implements HarnessGitHub {
  available = true;
  installUrl: string | null = "https://github.com/apps/cos-harness/installations/new";
  repos: AccessibleRepository[] = [
    { fullName: TEST_REPO, private: true, defaultBranch: "main", installationId: 1 },
  ];
  /** Other default-branch files by path; `.cos/harness.yml` comes from `policyText`. */
  repoFiles: Record<string, string> = {};
  readonly fileReads: string[] = [];
  pr: PullRequestInfo = {
    number: 7,
    title: "fix(settings): show saving state",
    body: "## 验证\nok\n## 审查\nok",
    state: "open",
    merged: false,
    draft: false,
    htmlUrl: `https://github.com/${TEST_REPO}/pull/7`,
    author: "octocat",
    headSha: "a".repeat(40),
    headRef: "harness/fix-7",
    headRepo: TEST_REPO,
    labels: [],
    baseRef: "main",
    mergeable: true,
    createdAt: new Date("2026-09-24T10:00:00Z"),
  };
  files: ChangedFile[] = [{ filename: "docs/guide.md", status: "modified" }];
  runs: CheckRunInput[] = [{ id: 1, name: "ci", status: "completed", conclusion: "success" }];
  statuses: CommitStatusInput[] = [];
  policyText: string | null = null;
  defaultSha = "b".repeat(40);
  readonly releases = new FakeReleaseGitHub();
  readonly merges: Array<{ number: number; sha: string; method: string }> = [];
  readonly deletedBranches: string[] = [];

  rememberInstallation() {}

  async listAccessibleRepositories() {
    return this.repos.map((repo) => ({ ...repo }));
  }

  async getDefaultBranch() {
    return { branch: "main", sha: this.defaultSha };
  }

  async getFile(_repo: string, path: string) {
    this.fileReads.push(path);
    return path === ".cos/harness.yml" ? this.policyText : (this.repoFiles[path] ?? null);
  }

  async listDirectory(_repo: string, path: string): Promise<DirectoryEntry[] | null> {
    const prefix = path ? `${path}/` : "";
    const names = new Map<string, DirectoryEntry["type"]>();
    for (const file of Object.keys(this.repoFiles)) {
      if (!file.startsWith(prefix)) continue;
      const [head, ...rest] = file.slice(prefix.length).split("/");
      names.set(head!, rest.length > 0 ? "dir" : "file");
    }
    if (names.size === 0 && path) return null;
    return [...names].map(([name, type]) => ({ name, type }));
  }

  async getPullRequest() {
    return { ...this.pr };
  }

  readonly branchLookups: string[] = [];

  async findOpenPullRequest(_repo: string, branch: string) {
    this.branchLookups.push(branch);
    const { pr } = this;
    return pr.state === "open" && pr.headRef === branch && pr.headRepo === TEST_REPO
      ? pr.number
      : null;
  }

  async listPullRequestFiles() {
    return this.files;
  }

  async listChecks() {
    return { runs: this.runs, statuses: this.statuses };
  }

  async getRequiredChecks() {
    return null;
  }

  async mergePullRequest(_repo: string, number: number, input: { sha: string; method: string }) {
    this.merges.push({ number, ...input });
    this.pr = { ...this.pr, merged: true, state: "closed" };
    return { merged: true, sha: "c".repeat(40), message: "merged" };
  }

  async deleteBranch(_repo: string, branch: string) {
    this.deletedBranches.push(branch);
  }

  readonly issues: Array<{ number: number; title: string; body: string; labels: string[] }> = [];
  readonly comments: Array<{ number: number; body: string }> = [];
  readonly labelsAdded: Array<{ number: number; labels: string[] }> = [];

  async createIssue(_repo: string, input: { title: string; body: string; labels: string[] }) {
    const number = 40 + this.issues.length + 1;
    this.issues.push({ number, ...input });
    return { number, url: `https://github.com/${TEST_REPO}/issues/${number}` };
  }

  async createComment(_repo: string, number: number, body: string) {
    this.comments.push({ number, body });
    return { id: this.comments.length };
  }

  async addLabels(_repo: string, number: number, labels: string[]) {
    this.labelsAdded.push({ number, labels });
  }

  /** Read queries the topic assistant made, as `<method> <repo> <args>`. */
  readonly reads: string[] = [];
  openIssues: IssueSummary[] = [];
  pulls: PullRequestSummary[] = [];
  commits: CommitSummary[] = [];
  issueDetails: Record<number, IssueDetail> = {};

  async listIssues(repo: string, input: { state: string; labels?: string; limit: number }) {
    this.reads.push(`listIssues ${repo} ${input.state}`);
    return this.openIssues.slice(0, input.limit);
  }

  async listPullRequests(repo: string, input: { state: string; limit: number }) {
    this.reads.push(`listPullRequests ${repo} ${input.state}`);
    return this.pulls.slice(0, input.limit);
  }

  async searchIssues(repo: string, query: string, limit: number) {
    this.reads.push(`searchIssues ${repo} ${query}`);
    return this.openIssues.filter((issue) => issue.title.includes(query)).slice(0, limit);
  }

  async getIssue(repo: string, number: number) {
    this.reads.push(`getIssue ${repo} ${number}`);
    const issue = this.issueDetails[number];
    if (!issue) throw new Error("Not Found");
    return issue;
  }

  async listCommits(repo: string, limit: number) {
    this.reads.push(`listCommits ${repo}`);
    return this.commits.slice(0, limit);
  }
}

export async function createTestService(
  options: {
    raw?: Record<string, unknown>;
    store?: MemoryHarnessStore;
    github?: FakeGitHub;
    now?: () => Date;
    lody?: Partial<LodyCli>;
    env?: Record<string, string | undefined>;
    /** Use the real LodyCli construction (local CLI or bridge) instead of a fake. */
    realLody?: boolean;
    summarizer?: PrSummarizer;
    panelUrl?: string;
    attachmentSecret?: string;
  } = {},
) {
  const store = options.store ?? new MemoryHarnessStore();
  const github = options.github ?? new FakeGitHub();
  const telegram = new FakeTelegram();
  let raw = options.raw ?? testConfigRaw();
  const now = options.now ?? (() => new Date("2026-09-24T12:00:00Z"));
  const logs: string[] = [];
  const log = (message: string) => void logs.push(message);
  const service = new HarnessService({
    configPath: "/etc/harness.yaml",
    store,
    github,
    logger: { info: log, warn: log, error: log } as never,
    summarizer: options.summarizer ?? (async ({ title }) => `摘要：${title}`),
    env: options.env ?? { HARNESS_GITHUB_WEBHOOK_SECRET: "s3cret" },
    now,
    panelUrl: options.panelUrl,
    attachmentSecret: options.attachmentSecret,
    loadConfig: async (sourcePath) => validateHarnessConfig({ raw, sourcePath, now: now() }),
    createLody: options.realLody ? undefined : () => withAgentList(options.lody),
  });
  await service.init();
  const port = service.claimBot({ id: "bot-1", name: "example-dev" })!;
  port.onBotReady(telegram);
  await service.apply();
  return {
    service,
    port,
    store,
    github,
    telegram,
    logs,
    setRaw: (next: Record<string, unknown>) => {
      raw = next;
    },
  };
}

const LODY_UNAVAILABLE = {
  ok: false as const,
  reason: "unavailable" as const,
  message: "未找到 lody CLI（lody）",
};

/** Partial fakes predate `listAgentConfigs`; they get an unavailable one. */
function withAgentList(lody: Partial<LodyCli> | undefined): LodyCli {
  const cli = (lody ?? { listMachines: async () => LODY_UNAVAILABLE }) as LodyCli;
  if (!("listAgentConfigs" in cli)) {
    Object.assign(cli, { listAgentConfigs: async () => LODY_UNAVAILABLE });
  }
  if (!("clearCatalogCache" in cli)) Object.assign(cli, { clearCatalogCache: () => {} });
  return cli;
}

export const TEST_AGENT_CONFIGS = [
  { id: "cfg-codex", name: "Codex", agentType: "codex", machineId: null },
  { id: "cfg-claude", name: "Claude Code", agentType: "claude", machineId: null },
];

const MACHINE_FIXTURE = readFileSync(
  new URL("./__fixtures__/lody-machine-list.txt", import.meta.url),
  "utf8",
);

/** Records every write; never touches a real Lody workspace. */
export class FakeLody {
  readonly created: CreateSessionInput[] = [];
  readonly chats: Array<{ sessionId: string; prompt: string; turnId?: string }> = [];
  readonly cancelled: string[] = [];
  readonly archived: string[] = [];
  createResult:
    | { ok: true; value: { sessionId: string } }
    | { ok: false; reason: "failed" | "unknown"; message: string }
    | null = null;
  session: Partial<LodySession> = {};
  onCreate?: () => void;

  constructor(private readonly now: () => Date) {}

  async listMachines() {
    return { ok: true as const, value: parseMachineList(extractJson(MACHINE_FIXTURE), this.now()) };
  }

  agentConfigs: AgentConfigInfo[] = TEST_AGENT_CONFIGS;

  clearCatalogCache() {}

  async listAgentConfigs() {
    return { ok: true as const, value: this.agentConfigs };
  }

  async createSession(input: CreateSessionInput) {
    this.created.push(input);
    this.onCreate?.();
    return (
      this.createResult ?? {
        ok: true as const,
        value: { sessionId: `sess-${this.created.length}` },
      }
    );
  }

  async chat(sessionId: string, prompt: string, turnId?: string) {
    this.chats.push({ sessionId, prompt, turnId });
    return { ok: true as const, value: undefined };
  }

  async showSession(sessionId: string) {
    return {
      ok: true as const,
      value: {
        id: sessionId,
        title: null,
        status: "running",
        machineId: "mac-0001",
        model: { id: "sonnet", name: "Sonnet 5" },
        context: { size: 1000, used: 430, percent: 43 },
        lastMessageAt: null,
        archived: false,
        ...this.session,
      } satisfies LodySession,
    };
  }

  lastAssistant: string | null = null;
  readonly historyReads: string[] = [];

  async lastAssistantMessage(sessionId: string) {
    this.historyReads.push(sessionId);
    return { ok: true as const, value: this.lastAssistant };
  }

  async cancelSession(sessionId: string) {
    this.cancelled.push(sessionId);
    return { ok: true as const, value: undefined };
  }

  async archiveSession(sessionId: string) {
    this.archived.push(sessionId);
    return { ok: true as const, value: undefined };
  }
}
