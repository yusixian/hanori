import type {
  HarnessEditMessage,
  HarnessMessageKind,
  HarnessOutgoingMessage,
  HarnessTelegram,
} from "@cos-tool-bot/bot";
import { validateHarnessConfig } from "./config/loader.js";
import type { CheckRunInput, CommitStatusInput } from "./contract.js";
import type { HarnessGitHub, PullRequestInfo } from "./github.js";
import { readFileSync } from "node:fs";
import {
  type CreateSessionInput,
  type LodyCli,
  type LodySession,
  extractJson,
  parseMachineList,
} from "./lody.js";
import { MemoryHarnessStore } from "./memory-store.js";
import type { ChangedFile } from "./risk.js";
import { HarnessService } from "./service.js";

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

  async sendDocument(_chatId: number, document: { filename: string }) {
    this.documents.push(document.filename);
  }

  async createForumTopic(_chatId: number, name: string) {
    this.topics.push(name);
    return 500 + this.topics.length;
  }

  async setChatCommands() {}

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
  readonly available = true;
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
  readonly merges: Array<{ number: number; sha: string; method: string }> = [];
  readonly deletedBranches: string[] = [];

  rememberInstallation() {}

  async getDefaultBranch() {
    return { branch: "main", sha: "b".repeat(40) };
  }

  async getFile() {
    return this.policyText;
  }

  async getPullRequest() {
    return { ...this.pr };
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
}

export async function createTestService(
  options: {
    raw?: Record<string, unknown>;
    store?: MemoryHarnessStore;
    github?: FakeGitHub;
    now?: () => Date;
    lody?: Partial<LodyCli>;
    env?: Record<string, string | undefined>;
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
    summarizer: async ({ title }) => `摘要：${title}`,
    env: options.env ?? { HARNESS_GITHUB_WEBHOOK_SECRET: "s3cret" },
    now,
    loadConfig: async (sourcePath) => validateHarnessConfig({ raw, sourcePath, now: now() }),
    createLody: () =>
      (options.lody ?? {
        listMachines: async () => ({
          ok: false,
          reason: "unavailable",
          message: "未找到 lody CLI（lody）",
        }),
      }) as unknown as LodyCli,
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

const MACHINE_FIXTURE = readFileSync(
  new URL("./__fixtures__/lody-machine-list.txt", import.meta.url),
  "utf8",
);

/** Records every write; never touches a real Lody workspace. */
export class FakeLody {
  readonly created: CreateSessionInput[] = [];
  readonly chats: Array<{ sessionId: string; prompt: string }> = [];
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

  async chat(sessionId: string, prompt: string) {
    this.chats.push({ sessionId, prompt });
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

  async cancelSession(sessionId: string) {
    this.cancelled.push(sessionId);
    return { ok: true as const, value: undefined };
  }

  async archiveSession(sessionId: string) {
    this.archived.push(sessionId);
    return { ok: true as const, value: undefined };
  }
}
