import { describe, expect, it, vi } from "vitest";
import { decodeCallback, encodeCallback } from "./approvals.js";
import { REQUEST_STATES as S } from "./states.js";
import { TEST_CHAT_ID, TEST_OWNER, TEST_REPO } from "./test-fakes.js";
import {
  type Ctx,
  START,
  bug,
  cardOf,
  harnessRaw,
  onlyRequest,
  setup,
} from "./work-test-helpers.js";

const WORKFLOWS = { ".github/workflows/ci.yml": "on:\n  pull_request:\n    paths: ['src/**']\n" };

function webhook(ctx: Ctx, event: string, payload: Record<string, unknown>) {
  return ctx.service.prFlow.handleWebhookEvent(
    event,
    { ...payload, repository: { full_name: TEST_REPO } },
    "sandbox",
  );
}

function checkRun(ctx: Ctx, action: string) {
  return webhook(ctx, "check_run", {
    action,
    check_run: { head_sha: ctx.github.pr.headSha, pull_requests: [{ number: 7 }] },
  });
}

/** A PR that was just opened: GitHub has not registered any checks yet. */
async function freshPr(ctx: Ctx) {
  ctx.github.runs = [];
  ctx.github.pr = { ...ctx.github.pr, createdAt: ctx.clock.now };
  await webhook(ctx, "pull_request", { action: "opened", pull_request: { number: 7 } });
}

function pressMerge(ctx: Ctx) {
  const details = decodeCallback(ctx.telegram.callbackData("🔍")!)!;
  return ctx.port.handleCallback({
    data: encodeCallback(details.approvalId, "merge"),
    chatId: TEST_CHAT_ID,
    threadId: 501,
    messageId: ctx.telegram.sent[0]!.messageId,
    userId: TEST_OWNER,
  });
}

describe("CI registration window", () => {
  it("blocks merging until CI registers in a repo that runs it on pull requests", async () => {
    const ctx = await setup();
    ctx.github.repoFiles = WORKFLOWS;
    await freshPr(ctx);
    const waiting = ctx.telegram.lastCard()!.html;
    expect(waiting).toContain("🟡 等待 CI · PR #7");
    expect(waiting).toContain("CI：⏳ 等待 CI 登记");
    expect(ctx.telegram.callbackData("✅ 合并")).toBeUndefined();
    expect(await pressMerge(ctx)).toEqual({ text: "CI 尚未登记，请稍候", alert: true });
    expect(ctx.github.merges).toEqual([]);

    ctx.github.runs = [{ id: 1, name: "ci", status: "queued", conclusion: null }];
    await checkRun(ctx, "created");
    expect(ctx.telegram.lastCard()!.html).toContain("CI：⏳ 1 项进行中 · ✅ 0/1");

    ctx.github.runs = [{ id: 1, name: "ci", status: "completed", conclusion: "success" }];
    await checkRun(ctx, "completed");
    expect(ctx.telegram.lastCard()!.html).toContain("🟢 可以合并");
  });

  it("ignores created check runs for cards that are not waiting", async () => {
    const ctx = await setup();
    await webhook(ctx, "pull_request", { action: "opened", pull_request: { number: 7 } });
    const edits = ctx.telegram.edits.length;
    ctx.github.runs = [];
    await checkRun(ctx, "created");
    expect(ctx.telegram.edits.length).toBe(edits);
  });

  it("gives up waiting after registrationTimeout, e.g. when path filters skip CI", async () => {
    const ctx = await setup();
    ctx.github.repoFiles = WORKFLOWS;
    await freshPr(ctx);
    ctx.advance(9 * 60_000);
    await ctx.service.work.scheduler.tick();
    expect(ctx.telegram.lastCard()!.html).toContain("等待 CI 登记");
    ctx.advance(60_000);
    await ctx.service.work.scheduler.tick();
    const card = ctx.telegram.lastCard()!.html;
    expect(card).toContain("🟢 可以合并");
    expect(card).toContain("CI：未发现检查");
  });

  it("holds a repo without CI only for the grace period after a push", async () => {
    const ctx = await setup();
    await freshPr(ctx);
    expect(ctx.telegram.lastCard()!.html).toContain("等待 CI 登记");
    ctx.advance(30_000);
    await ctx.service.work.scheduler.tick();
    expect(ctx.telegram.callbackData("✅ 合并")).toBeUndefined();
    ctx.advance(31_000);
    await ctx.service.work.scheduler.tick();
    expect(ctx.telegram.lastCard()!.html).toContain("🟢 可以合并");

    ctx.github.pr = { ...ctx.github.pr, headSha: "d".repeat(40) };
    await webhook(ctx, "pull_request", { action: "synchronize", pull_request: { number: 7 } });
    expect(ctx.telegram.lastCard()!.html).toContain("等待 CI 登记");
  });
});

/** Holds the next sync at its check read until `release()`; `waiting` settles once it is held. */
function holdChecks(ctx: Ctx) {
  const listChecks = ctx.github.listChecks.bind(ctx.github);
  let release!: () => void;
  let reached!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  const waiting = new Promise<void>((resolve) => (reached = resolve));
  ctx.github.listChecks = async () => {
    ctx.github.listChecks = listChecks;
    reached();
    await gate;
    return listChecks();
  };
  return { waiting, release };
}

async function linkedPr(ctx: Ctx) {
  await bug(ctx);
  await ctx.service.work.scheduler.tick();
  ctx.github.pr = { ...ctx.github.pr, headRef: `harness/${onlyRequest(ctx).id}` };
  await webhook(ctx, "pull_request", { action: "opened", pull_request: { number: 7 } });
  expect(onlyRequest(ctx).state).toBe(S.prReady);
  return onlyRequest(ctx);
}

describe("state changes during a PR sync", () => {
  it("keeps a cancel made while the sync was reading GitHub", async () => {
    const ctx = await setup();
    const request = await linkedPr(ctx);
    const held = holdChecks(ctx);
    const sync = ctx.service.prFlow.sync("sandbox", 7, { reason: "refresh" });
    await held.waiting;
    const cancel = ctx.service.work.withRequest(request.id, async () =>
      ctx.service.work.cancel((await ctx.store.getRequest(request.id))!, TEST_OWNER, "不做了"),
    );
    await vi.waitFor(() => expect(onlyRequest(ctx).state).toBe(S.cancelled));
    held.release();
    await Promise.all([sync, cancel]);

    expect(onlyRequest(ctx)).toMatchObject({ state: S.cancelled, stateReason: "不做了" });
    const card = cardOf(ctx, request.cardMessageId!)!;
    expect(card.html).toContain("⚫ 请求已取消");
    expect(card.keyboard!.flat().map((b) => b.text)).toEqual(["🔗 PR"]);
    expect(ctx.telegram.sent).toHaveLength(1);
    expect(ctx.lody.cancelled).toEqual(["sess-1"]);
  });

  it("renders the card again from the state another writer moved to", async () => {
    const ctx = await setup();
    const request = await linkedPr(ctx);
    const held = holdChecks(ctx);
    const sync = ctx.service.prFlow.sync("sandbox", 7, { reason: "refresh" });
    await held.waiting;
    const reason = "Lody 会话已停下，但 PR 仍是草稿";
    const moved = ctx.store.transitionRequest(request.id, [S.prReady], S.needsAttention, {
      stateReason: reason,
    });
    expect(await moved).toBe(true);
    held.release();
    await sync;

    expect(onlyRequest(ctx)).toMatchObject({ state: S.needsAttention, stateReason: reason });
    expect(cardOf(ctx, request.cardMessageId!)!.html).toContain(`👀 需要你看一下：${reason}`);
  });

  it("sends a CI fix round to the session only for the attempt that won", async () => {
    const ctx = await setup();
    const request = await linkedPr(ctx);
    ctx.github.runs = [{ id: 1, name: "test", status: "completed", conclusion: "failure" }];
    const held = holdChecks(ctx);
    const sync = ctx.service.prFlow.sync("sandbox", 7, { reason: "check_run" });
    await held.waiting;
    expect(await ctx.store.transitionRequest(request.id, [S.prReady], S.revising)).toBe(true);
    held.release();
    await sync;

    expect(ctx.lody.chats).toHaveLength(1);
    expect(ctx.lody.chats[0]!.prompt).toContain("CI failed on pull request #7 (round 1 of 2)");
    expect(onlyRequest(ctx)).toMatchObject({ state: S.revising, fixRounds: 1 });
  });

  it("sends no CI fix round for an attempt a cancel overtook", async () => {
    const ctx = await setup();
    const request = await linkedPr(ctx);
    ctx.github.runs = [{ id: 1, name: "test", status: "completed", conclusion: "failure" }];
    const held = holdChecks(ctx);
    const sync = ctx.service.prFlow.sync("sandbox", 7, { reason: "check_run" });
    await held.waiting;
    expect(await ctx.store.transitionRequest(request.id, [S.prReady], S.cancelled)).toBe(true);
    held.release();
    await sync;

    expect(ctx.lody.chats).toEqual([]);
    expect(onlyRequest(ctx)).toMatchObject({ state: S.cancelled, fixRounds: 0 });
  });

  it("handles a new head before the state write, so a crash right after it loses nothing", async () => {
    const ctx = await setup();
    await linkedPr(ctx);
    const stale = decodeCallback(ctx.telegram.callbackData("🔍")!)!.approvalId;
    const head = "d".repeat(40);
    ctx.github.pr = { ...ctx.github.pr, headSha: head };
    ctx.github.runs = [{ id: 1, name: "test", status: "completed", conclusion: "failure" }];
    const transition = ctx.store.transitionRequest.bind(ctx.store);
    ctx.store.transitionRequest = async (...args: Parameters<typeof transition>) => {
      ctx.store.transitionRequest = transition;
      if (await transition(...args)) throw new Error("crashed after the write");
      return false;
    };
    const sync = ctx.service.prFlow.sync("sandbox", 7, { reason: "check_run" });
    await expect(sync).rejects.toThrow("crashed after the write");

    expect(onlyRequest(ctx)).toMatchObject({ state: S.prReady, headSha: head, fixRounds: 0 });
    const shown = decodeCallback(ctx.telegram.callbackData("🔍")!)!.approvalId;
    expect(ctx.store.approvals.get(stale)).toMatchObject({ invalidReason: "new_push" });
    expect(ctx.store.approvals.get(shown)).toMatchObject({ headSha: head, invalidatedAt: null });
    const moves = ctx.store.events.filter((e) => e.type === "pr.head_changed");
    expect(moves.filter((e) => e.payload?.to === head)).toHaveLength(1);

    await ctx.service.prFlow.sync("sandbox", 7, { reason: "check_run" });
    expect(ctx.lody.chats).toHaveLength(1);
    expect(onlyRequest(ctx).fixRounds).toBe(1);
  });

  it("keeps what GitHub reported when every attempt loses", async () => {
    const ctx = await setup();
    const request = await linkedPr(ctx);
    const head = "d".repeat(40);
    ctx.github.pr = { ...ctx.github.pr, headSha: head };
    const edit = ctx.telegram.edit.bind(ctx.telegram);
    ctx.telegram.edit = async (...args: Parameters<typeof edit>) => {
      const current = (await ctx.store.getRequest(request.id))!;
      const next = current.state === S.prReady ? S.needsAttention : S.prReady;
      await ctx.store.transitionRequest(request.id, [current.state], next, {
        stateReason: "别处在改",
      });
      return edit(...args);
    };
    const pushedAt = new Date(START.getTime() + 1_000);
    const bodyEditedAt = new Date(START.getTime() + 2_000);
    await ctx.service.prFlow.sync("sandbox", 7, { reason: "test", pushedAt, bodyEditedAt });

    expect(onlyRequest(ctx)).toMatchObject({
      state: S.needsAttention,
      stateReason: "别处在改",
      headSha: head,
      lastPushAt: pushedAt,
      bodyEditedAt,
    });
    expect(ctx.logs.some((line) => line.includes("kept the PR fields only"))).toBe(true);
  });

  it("edits the card a lost attempt sent instead of sending another", async () => {
    const ctx = await setup();
    const held = holdChecks(ctx);
    const sync = webhook(ctx, "pull_request", { action: "opened", pull_request: { number: 7 } });
    await held.waiting;
    const tracked = (await ctx.store.findRequestByPr(TEST_REPO, 7))!;
    expect(await ctx.store.transitionRequest(tracked.id, [S.open], S.closed)).toBe(true);
    held.release();
    await sync;

    expect(ctx.telegram.sent).toHaveLength(1);
    expect(onlyRequest(ctx)).toMatchObject({
      state: S.open,
      cardMessageId: ctx.telegram.sent[0]!.messageId,
    });
  });
});

describe("reconciler", () => {
  it("applies a merge whose webhook was lost", async () => {
    const ctx = await setup();
    await webhook(ctx, "pull_request", { action: "opened", pull_request: { number: 7 } });
    await ctx.service.work.scheduler.tick();
    expect(onlyRequest(ctx).state).toBe(S.open);

    ctx.github.pr = { ...ctx.github.pr, merged: true, state: "closed" };
    ctx.advance(60_000);
    await ctx.service.work.scheduler.tick();
    expect(onlyRequest(ctx).state).toBe(S.open);
    ctx.advance(2 * 60_000);
    await ctx.service.work.scheduler.tick();
    expect(onlyRequest(ctx).state).toBe(S.merged);
    expect(ctx.telegram.lastCard()!.html).toContain("🟣 已合并");
  });

  it("links a PR the session opened on its branch when no webhook arrived", async () => {
    const ctx = await setup();
    await bug(ctx);
    await ctx.service.work.scheduler.tick();
    const request = onlyRequest(ctx);
    ctx.github.pr = { ...ctx.github.pr, headRef: `harness/${request.id}` };
    ctx.advance(3 * 60_000);
    await ctx.service.work.scheduler.tick();
    expect(ctx.github.branchLookups).toContain(`harness/${request.id}`);
    expect(onlyRequest(ctx)).toMatchObject({ prNumber: 7, state: S.prReady });
    expect(cardOf(ctx, request.cardMessageId!)!.html).toContain("PR #7");
    expect(ctx.store.events.some((e) => e.type === "reconcile.pr_found")).toBe(true);
  });

  it("checks a bounded batch per interval and rotates through requests", async () => {
    const ctx = await setup({
      raw: harnessRaw({
        guardrails: { concurrency: { sameAreaWriters: 5 } },
        github: { reconcile: { interval: "5m", batch: 1 } },
      }),
    });
    await bug(ctx, "first");
    await bug(ctx, "second");
    await ctx.service.work.scheduler.tick();
    const lookups = () => ctx.github.branchLookups.length;
    const before = lookups();
    ctx.advance(5 * 60_000);
    await ctx.service.work.scheduler.tick();
    await ctx.service.work.scheduler.tick();
    expect(lookups()).toBe(before + 1);
    ctx.advance(5 * 60_000);
    await ctx.service.work.scheduler.tick();
    const recent = ctx.github.branchLookups.slice(-2);
    expect(new Set(recent).size).toBe(2);
  });
});
