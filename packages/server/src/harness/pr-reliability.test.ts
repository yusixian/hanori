import { describe, expect, it } from "vitest";
import { decodeCallback, encodeCallback } from "./approvals.js";
import { REQUEST_STATES as S } from "./states.js";
import { TEST_CHAT_ID, TEST_OWNER, TEST_REPO } from "./test-fakes.js";
import { type Ctx, bug, cardOf, harnessRaw, onlyRequest, setup } from "./work-test-helpers.js";

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
