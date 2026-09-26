import { describe, expect, it, vi } from "vitest";
import { harnessRoutes } from "../routes/harness.js";
import { REQUEST_STATES as S } from "./states.js";
import type { TurnEnd, TurnStatus } from "./lody-wait.js";
import { signTurnEnd, verifyTurnSignature } from "./turn-callback.js";
import { type Ctx, START, bug, onlyRequest, setup } from "./work-test-helpers.js";

const SECRET = "c".repeat(40);
const ENV = { HARNESS_GITHUB_WEBHOOK_SECRET: "s3cret", HARNESS_LODY_BRIDGE_SECRET: SECRET };

const withSecret = () => setup({ env: ENV });

function post(ctx: Ctx, end: object, options: { secret?: string; at?: Date } = {}) {
  const body = JSON.stringify(end);
  const timestamp = String(Math.floor((options.at ?? ctx.clock.now).getTime() / 1000));
  return harnessRoutes(ctx.service).request("/lody/turn", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-harness-timestamp": timestamp,
      "x-harness-signature": signTurnEnd(options.secret ?? SECRET, timestamp, body),
    },
    body,
  });
}

const ended = (sessionId: string, status: TurnStatus = "completed"): TurnEnd => ({
  sessionId,
  command: "create",
  status,
  exitCode: 0,
  startedAt: START.toISOString(),
  endedAt: START.toISOString(),
});

const notices = (ctx: Ctx) => ctx.telegram.sent.filter((s) => s.message.html.startsWith("⏸"));

async function runningBug(ctx: Ctx) {
  await bug(ctx);
  await ctx.service.work.scheduler.tick();
  return onlyRequest(ctx);
}

describe("turn callback signature", () => {
  const body = '{"sessionId":"s-1"}';
  const now = START.getTime();
  const at = (ms: number) => String(Math.floor((now + ms) / 1000));

  it("accepts a fresh signature over the timestamp and the exact body", () => {
    const timestamp = at(0);
    const signature = signTurnEnd(SECRET, timestamp, body);
    expect(verifyTurnSignature(SECRET, { timestamp, signature, body }, now)).toBe(true);
  });

  it.each([
    ["another secret", { signature: signTurnEnd("d".repeat(40), at(0), body) }],
    ["a changed body", { body: '{"sessionId":"s-2"}' }],
    ["a stale timestamp", { timestamp: at(-6 * 60_000) }],
    ["a future timestamp", { timestamp: at(6 * 60_000) }],
    ["no signature", { signature: undefined }],
    ["no timestamp", { timestamp: undefined }],
    ["a truncated signature", { signature: "sha256=abc" }],
  ])("rejects %s", (_name, change) => {
    const timestamp = at(0);
    const request = { timestamp, signature: signTurnEnd(SECRET, timestamp, body), body, ...change };
    if ("timestamp" in change && change.timestamp && !("signature" in change)) {
      request.signature = signTurnEnd(SECRET, change.timestamp, body);
    }
    expect(verifyTurnSignature(SECRET, request, now)).toBe(false);
  });
});

describe("POST /api/harness/lody/turn", () => {
  it("rejects bad signatures and bodies, and is absent without a bridge secret", async () => {
    const ctx = await withSecret();
    expect((await post(ctx, ended("sess-1"), { secret: "e".repeat(40) })).status).toBe(401);
    expect(
      (await post(ctx, ended("sess-1"), { at: new Date(START.getTime() - 10 * 60_000) })).status,
    ).toBe(401);
    expect((await post(ctx, { ...ended("sess-1"), status: "exploded" })).status).toBe(400);
    expect((await post(ctx, { ...ended("../x") })).status).toBe(400);
    expect(ctx.logs.filter((line) => line.includes("turn callback"))).toEqual([]);

    const bare = await setup();
    expect((await post(bare, ended("sess-1"))).status).toBe(404);
  });

  it("checks the job at once and treats one idle status as the end", async () => {
    const ctx = await withSecret();
    const request = await runningBug(ctx);
    ctx.lody.session = { status: "idle" };
    ctx.lody.lastAssistant = "Done, but I could not push.";
    const response = await post(ctx, ended("sess-1"));
    expect(response.status).toBe(202);
    await vi.waitFor(() =>
      expect(onlyRequest(ctx)).toMatchObject({
        state: S.needsAttention,
        stateReason: "Lody 会话已停下，但还没有提交 PR",
      }),
    );
    expect(notices(ctx)).toHaveLength(1);
    expect(notices(ctx)[0]!.message.replyToMessageId).toBe(request.cardMessageId);
    const event = ctx.store.events.find((e) => e.type === "session.turn_ended")!;
    expect(event).toMatchObject({ requestId: request.id });
    expect(event.payload).toEqual({ status: "completed", command: "create", matched: true });
  });

  it("waits for Lody's status when it still says running, and keeps the mark for the next poll", async () => {
    const ctx = await withSecret();
    await runningBug(ctx);
    await ctx.service.work.onTurnEnd(ended("sess-1"));
    expect(onlyRequest(ctx).state).toBe(S.running);
    ctx.lody.session = { status: "idle" };
    ctx.advance(20_000);
    await ctx.service.work.scheduler.tick();
    expect(onlyRequest(ctx).state).toBe(S.needsAttention);
  });

  it("does not skip the debounce after an unfinished turn or once the owner sent a new turn", async () => {
    const ctx = await withSecret();
    await runningBug(ctx);
    ctx.lody.session = { status: "idle" };
    for (const status of ["timeout", "failed", "canceled"] as const) {
      await ctx.service.work.onTurnEnd(ended("sess-1", status));
      expect(onlyRequest(ctx).state).toBe(S.running);
      expect(ctx.service.work.turnEnded("sess-1")).toBe(false);
    }

    ctx.lody.session = { status: "running" };
    await ctx.service.work.onTurnEnd(ended("sess-1"));
    expect(ctx.service.work.turnEnded("sess-1")).toBe(true);
    await ctx.service.work.withRequest(onlyRequest(ctx).id, () =>
      ctx.service.work.sendToSession(onlyRequest(ctx), "answer", { ownerText: "go on" }),
    );
    expect(ctx.service.work.turnEnded("sess-1")).toBe(false);
    ctx.lody.session = { status: "idle" };
    ctx.advance(20_000);
    await ctx.service.work.scheduler.tick();
    expect(onlyRequest(ctx).state).toBe(S.running);
  });

  it("preserves correlation through the signed callback with a skewed bridge clock", async () => {
    const ctx = await withSecret();
    const request = await runningBug(ctx);
    await ctx.service.work.withRequest(request.id, () =>
      ctx.service.work.sendToSession(request, "answer", { ownerText: "continue" }),
    );
    const turnId = ctx.lody.chats.at(-1)!.turnId;
    const at = new Date(ctx.clock.now.getTime() - 60_000);
    const end = { ...ended("sess-1", "failed"), turnId, startedAt: at.toISOString() };
    expect((await post(ctx, end, { at })).status).toBe(202);
    await vi.waitFor(() => expect(ctx.service.work.turnStatus("sess-1")).toBe("failed"));
  });

  it("records an unknown session without touching any request", async () => {
    const ctx = await withSecret();
    await runningBug(ctx);
    await ctx.service.work.onTurnEnd(ended("sess-other"));
    expect(onlyRequest(ctx).state).toBe(S.running);
    expect(ctx.store.events.find((e) => e.type === "session.turn_ended")!.payload).toMatchObject({
      matched: false,
    });
  });
});
