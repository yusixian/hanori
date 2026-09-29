import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { createDb, type Database } from "@cos-tool-bot/database";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DrizzleHarnessStore } from "./store.js";

const url = process.env.HARNESS_STORE_TEST_DATABASE_URL;
const MIGRATIONS = [
  "0054_harness_foundation.sql",
  "0055_harness_jobs.sql",
  "0056_harness_panel_projects.sql",
  "0057_harness_topic_messages.sql",
].map((name) => new URL(`../../../database/drizzle/${name}`, import.meta.url));
// Explicit opt-in; never use the application's DATABASE_URL.
describe.skipIf(!url)("DrizzleHarnessStore PostgreSQL integration", () => {
  let client: ReturnType<typeof createDb>["client"];
  let store: DrizzleHarnessStore;
  const namespace = `harness_store_test_${randomUUID().replaceAll("-", "")}`;
  const now = new Date("2026-09-24T12:00:00Z");

  beforeAll(async () => {
    const parsed = new URL(url!);
    if (
      !["127.0.0.1", "localhost"].includes(parsed.hostname) ||
      !parsed.pathname.endsWith("_test")
    ) {
      throw new Error("Harness store integration requires a local *_test database");
    }
    parsed.searchParams.set("search_path", namespace);
    // Far from UTC, so a timestamp left to the session's `now()` shows up as hours off.
    parsed.searchParams.set("TimeZone", "Pacific/Kiritimati");
    const connection = createDb(parsed.toString());
    client = connection.client;
    store = new DrizzleHarnessStore(connection.db as Database);
    await client.unsafe(`CREATE SCHEMA "${namespace}"`);
    for (const file of MIGRATIONS) {
      const migration = readFileSync(file, "utf8").replaceAll('"public".', `"${namespace}".`);
      for (const statement of migration.split("--> statement-breakpoint")) {
        if (statement.trim()) await client.unsafe(statement);
      }
    }
  });

  afterAll(async () => {
    await client?.unsafe(`DROP SCHEMA IF EXISTS "${namespace}" CASCADE`);
    await client?.end();
  });

  async function request(prNumber: number, projectKey = "sandbox") {
    return store.insertRequest({
      projectKey,
      type: "pr",
      state: "open",
      repo: "example-owner/harness-sandbox",
      prNumber,
      headSha: "a".repeat(40),
    });
  }

  function approval(id: string, requestId: string, headSha: string, expiresAt: Date) {
    return {
      id,
      requestId,
      action: "merge",
      repo: "example-owner/harness-sandbox",
      prNumber: 1,
      headSha,
      expiresAt,
      consumedAt: null,
      consumedBy: null,
      invalidatedAt: null,
      invalidReason: null,
    };
  }

  it("lets exactly one concurrent consumer win an approval", async () => {
    const target = await request(1);
    await store.createApproval(
      approval("approval-race-000001", target.id, "a".repeat(40), new Date(now.getTime() + 60_000)),
    );
    const results = await Promise.all(
      Array.from({ length: 5 }, () => store.consumeApproval("approval-race-000001", 42, now)),
    );
    expect(results.filter(Boolean)).toHaveLength(1);
    expect((await store.getApproval("approval-race-000001"))?.consumedBy).toBe(42);
  });

  it("refuses expired approvals and invalidates only other head SHAs", async () => {
    const target = await request(2);
    const future = new Date(now.getTime() + 60_000);
    await store.createApproval(
      approval("approval-old-00000001", target.id, "a".repeat(40), future),
    );
    await store.createApproval(
      approval("approval-new-00000001", target.id, "b".repeat(40), future),
    );
    await store.createApproval(
      approval("approval-exp-00000001", target.id, "b".repeat(40), new Date(now.getTime() - 1)),
    );
    expect(await store.consumeApproval("approval-exp-00000001", 42, now)).toBe(false);
    expect(await store.invalidateApprovals(target.id, "new_push", now, "b".repeat(40))).toBe(1);
    expect((await store.getApproval("approval-old-00000001"))?.invalidReason).toBe("new_push");
    expect((await store.findUsableApproval(target.id, "b".repeat(40), now))?.id).toBe(
      "approval-new-00000001",
    );
  });

  it("records each webhook delivery once", async () => {
    expect(await store.recordDelivery("delivery-it-1", { type: "github.ping" })).toBe(true);
    expect(await store.recordDelivery("delivery-it-1", { type: "github.ping" })).toBe(false);
    await store.recordDelivery("queue-it-1", { type: "queue.waiting", payload: { since: "x" } });
    expect(await store.findDelivery("queue-it-1")).toEqual({ payload: { since: "x" } });
    expect(await store.findDelivery("missing")).toBeNull();
  });

  it("upserts overrides and prunes expired ones", async () => {
    const base = { scope: "global", actorId: 1, updatedAt: now };
    await store.putOverride({
      ...base,
      path: "guardrails.autoFixRounds",
      value: 3,
      expiresAt: null,
    });
    await store.putOverride({
      ...base,
      path: "guardrails.autoFixRounds",
      value: 4,
      expiresAt: null,
    });
    await store.putOverride({
      ...base,
      path: "guardrails.time.idleRemindAfter",
      value: "10m",
      expiresAt: new Date(now.getTime() - 1),
    });
    expect(await store.deleteExpiredOverrides(now)).toBe(1);
    expect(await store.listOverrides()).toMatchObject([
      { path: "guardrails.autoFixRounds", value: 4 },
    ]);
    expect(await store.deleteOverride("global", "guardrails.autoFixRounds")).toBe(true);
  });

  it("keeps topic bindings across upserts", async () => {
    await store.upsertProject("sandbox", "example-owner/harness-sandbox", { chatId: -100, threadId: 9 });
    await store.upsertProject("sandbox", "example-owner/harness-sandbox", { policyError: null });
    const [project] = await store.listProjects();
    expect(project).toMatchObject({ key: "sandbox", chatId: -100, threadId: 9 });
  });

  it("stores and clears a panel binding with its policy patch", async () => {
    const binding = { repo: "example-owner/koyori", machines: ["mbp"] };
    await store.upsertProject("koyori", binding.repo, {
      binding,
      policyPatch: { verify: { quick: "pnpm lint" } },
      inferredPolicy: { kind: "electron" },
    });
    let row = (await store.listProjects()).find((p) => p.key === "koyori");
    expect(row).toMatchObject({ binding, policyPatch: { verify: { quick: "pnpm lint" } } });
    await store.upsertProject("koyori", binding.repo, { binding: null, policyPatch: null });
    row = (await store.listProjects()).find((p) => p.key === "koyori");
    expect(row).toMatchObject({
      binding: null,
      policyPatch: null,
      inferredPolicy: { kind: "electron" },
    });
  });

  it("upserts and removes panel settings", async () => {
    expect(await store.getSetting("execution")).toBeNull();
    await store.putSetting("execution", { model: "gpt-6-sol" }, 42);
    await store.putSetting("execution", { model: "gpt-6-astra" }, 42);
    expect(await store.getSetting("execution")).toEqual({ model: "gpt-6-astra" });
    await store.putSetting("execution", null, 42);
    expect(await store.getSetting("execution")).toBeNull();
  });

  it("lets exactly one scheduler claim a queued request", async () => {
    const target = await request(3);
    await store.transitionRequest(target.id, ["open"], "queued");
    const claims = await Promise.all(
      Array.from({ length: 4 }, () => store.transitionRequest(target.id, ["queued"], "starting")),
    );
    expect(claims.filter(Boolean)).toHaveLength(1);
    const job = {
      requestId: target.id,
      attempt: 1,
      executor: "lody",
      state: "starting",
      machineKey: "mbp",
      lodyMachine: "MBP",
      provider: "claude",
      role: "worker",
      agent: "Claude Code",
    };
    await store.insertJob(job);
    await expect(store.insertJob(job)).rejects.toThrow();
    expect((await store.latestJob(target.id))?.attempt).toBe(1);
    expect(await store.countJobsSince(new Date(0))).toBe(1);
  });

  it("writes a transition's fields only while its guard holds", async () => {
    const target = await request(5);
    const lost = await store.transitionRequest(target.id, ["queued"], "starting", {
      stateReason: "lost",
    });
    expect(lost).toBe(false);
    expect(await store.getRequest(target.id)).toMatchObject({ state: "open", stateReason: null });
    const won = await store.transitionRequest(target.id, ["queued", "open"], "starting", {
      stateReason: "won",
    });
    expect(won).toBe(true);
    expect(await store.getRequest(target.id)).toMatchObject({
      state: "starting",
      stateReason: "won",
    });
  });

  it("finds requests by issue, card, and state in creation order", async () => {
    const a = await request(4);
    await store.transitionRequest(a.id, ["open"], "queued", {
      issueNumber: 12,
      chatId: -100,
      cardMessageId: 55,
    });
    expect((await store.findRequestByIssue("example-owner/harness-sandbox", 12))?.id).toBe(a.id);
    expect((await store.findRequestByCard(-100, 55))?.id).toBe(a.id);
    expect((await store.listRequestsByState(["queued"])).map((r) => r.id)).toEqual([a.id]);
    const message = { chatId: -100, messageId: 56, requestId: a.id, kind: "question" };
    await store.recordMessage({ ...message, ref: { number: 12 } });
    await store.recordMessage({ ...message, ref: null });
    expect((await store.findMessage(-100, 56))?.ref).toEqual({ number: 12 });
  });

  it("keeps topic conversations apart, uses each suggestion once, and prunes", async () => {
    const topic = { chatId: -100, threadId: 9 };
    for (const text of ["a", "b", "c"]) {
      await store.appendTopicMessage({ ...topic, role: "user", text });
    }
    await store.appendTopicMessage({
      ...topic,
      role: "assistant",
      text: "d",
      messageId: 77,
      suggestions: [{ command: "bug", args: "x", project: null }],
    });
    await store.appendTopicMessage({ chatId: -100, threadId: 0, role: "user", text: "general" });
    expect((await store.listTopicMessages(-100, 9, 2)).map((m) => m.text)).toEqual(["c", "d"]);

    const row = (await store.findTopicMessage(-100, 77))!;
    const uses = await Promise.all(
      Array.from({ length: 4 }, () => store.useTopicSuggestion(row.id, 0)),
    );
    expect(uses.filter(Boolean)).toHaveLength(1);
    expect(await store.useTopicSuggestion(row.id, 1)).toBe(true);
    expect((await store.findTopicMessage(-100, 77))?.suggestionsUsed).toBe(3);

    await store.pruneTopicMessages({ ...topic, keep: 2, before: new Date(0) });
    expect((await store.listTopicMessages(-100, 9, 10)).map((m) => m.text)).toEqual(["c", "d"]);
    await store.pruneTopicMessages({ ...topic, keep: 10, before: new Date(Date.now() + 60_000) });
    expect(await store.listTopicMessages(-100, 0, 10)).toEqual([]);

    await store.appendTopicMessage({ ...topic, role: "user", text: "e" });
    expect(await store.clearTopic(-100, 9)).toBe(1);
  });

  it("stamps inserts with the process clock, whatever the session TimeZone", async () => {
    const near = (date: Date | undefined) =>
      expect(Math.abs(date!.getTime() - Date.now())).toBeLessThan(60_000);
    const target = await request(30);
    near(target.createdAt);
    near(target.updatedAt);
    await store.insertJob({
      requestId: target.id,
      attempt: 1,
      executor: "lody",
      state: "starting",
      machineKey: "mbp",
      lodyMachine: "MBP",
      provider: "claude",
      role: "worker",
      agent: "Claude Code",
    });
    const job = await store.latestJob(target.id);
    near(job?.createdAt);
    near(job?.updatedAt);
    expect(await store.countJobsSince(new Date(Date.now() + 60_000))).toBe(0);
    await store.recordEvent({ type: "stamped", requestId: target.id });
    near((await store.listRequestEvents(target.id, 1))[0]?.createdAt);
    await store.appendTopicMessage({ chatId: -300, threadId: 1, role: "user", text: "t" });
    near((await store.listTopicMessages(-300, 1, 1))[0]?.createdAt);
    const expiresAt = new Date(Date.now() + 60_000);
    await store.createApproval(
      approval("approval-stamp-00001", target.id, "a".repeat(40), expiresAt),
    );
    near((await store.getApproval("approval-stamp-00001"))?.createdAt);
    await store.recordMessage({
      chatId: -300,
      messageId: 1,
      requestId: target.id,
      kind: "question",
    });
    near((await store.findMessage(-300, 1))?.createdAt);
    await store.upsertProject("stamped", "example-owner/stamped", {});
    near((await store.listProjects()).find((p) => p.key === "stamped")?.createdAt);
  });

  it("keeps insertion order for requests stamped within one millisecond", async () => {
    const rows = await Promise.all([40, 41, 42, 43, 44].map((pr) => request(pr, "fifo")));
    const queue = (await store.listRequestsByState(["open"])).filter(
      (r) => r.projectKey === "fifo",
    );
    expect(queue.map((r) => r.id)).toEqual(rows.map((r) => r.id));
    expect(new Set(queue.map((r) => r.createdAt.getTime())).size).toBe(rows.length);
  });

  it("lists a project's requests and a request's events newest first", async () => {
    const a = await request(20, "listing");
    const b = await request(21, "listing");
    // Timestamps have millisecond precision.
    await new Promise((resolve) => setTimeout(resolve, 5));
    await store.updateRequest(a.id, { title: "renamed" });
    expect((await store.listProjectRequests("listing", 2)).map((r) => r.id)).toEqual([a.id, b.id]);
    await store.recordEvent({ type: "first", requestId: a.id });
    await store.recordEvent({ type: "second", requestId: a.id });
    expect((await store.listRequestEvents(a.id, 5)).map((e) => e.type)).toEqual([
      "second",
      "first",
    ]);
  });
});
