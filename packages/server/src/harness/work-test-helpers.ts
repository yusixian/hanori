/** Shared setup for the execution-loop tests. */
import { MemoryHarnessStore } from "./memory-store.js";
import {
  FakeGitHub,
  FakeLody,
  TEST_CHAT_ID,
  TEST_OWNER,
  TEST_REPO,
  createTestService,
  testConfigRaw,
} from "./test-fakes.js";

export const START = new Date("2026-09-24T12:00:00Z");

/** Pins a Claude lead so the quota fixtures (Claude windows) keep applying. */
export function harnessRaw(extra: Record<string, unknown> = {}) {
  return testConfigRaw({
    machines: { mbp: { lody: "MBP-64G" } },
    roles: { worker: { agent: "Claude Code", model: "sonnet", effort: "medium" } },
    projects: { sandbox: { repo: TEST_REPO, machines: ["mbp"] } },
    ...extra,
  });
}

export async function setup(
  options: {
    raw?: Record<string, unknown>;
    store?: MemoryHarnessStore;
    panelUrl?: string;
    attachmentSecret?: string;
  } = {},
) {
  const clock = { now: START };
  const lody = new FakeLody(() => clock.now);
  const github = new FakeGitHub();
  const ctx = await createTestService({
    raw: options.raw ?? harnessRaw(),
    store: options.store,
    github,
    lody,
    now: () => clock.now,
    panelUrl: options.panelUrl,
    attachmentSecret: options.attachmentSecret,
  });
  const advance = (ms: number) => {
    clock.now = new Date(clock.now.getTime() + ms);
  };
  return { ...ctx, lody, clock, advance };
}

export type Ctx = Awaited<ReturnType<typeof setup>>;

export async function bug(ctx: Ctx, text = "保存按钮没有反应\n网络慢时尤其明显") {
  return ctx.port.handleCommand({
    command: "bug",
    args: text,
    chatId: TEST_CHAT_ID,
    threadId: 501,
    userId: TEST_OWNER,
    messageId: 9,
    attachments: [{ kind: "photo", fileId: "AgACfile" }],
  });
}

export function onlyRequest(ctx: Ctx) {
  const [request] = [...ctx.store.requests.values()];
  return request!;
}

export function cardOf(ctx: Ctx, messageId: number) {
  const edits = ctx.telegram.edits.filter((edit) => edit.messageId === messageId);
  return edits.at(-1)?.message ?? ctx.telegram.sent.find((s) => s.messageId === messageId)?.message;
}
