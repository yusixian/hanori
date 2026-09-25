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

  async function request(prNumber: number) {
    return store.insertRequest({
      projectKey: "sandbox",
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
    await store.updateRequest(target.id, { state: "queued" });
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

  it("finds requests by issue, card, and state in creation order", async () => {
    const a = await request(4);
    await store.updateRequest(a.id, {
      issueNumber: 12,
      chatId: -100,
      cardMessageId: 55,
      state: "queued",
    });
    expect((await store.findRequestByIssue("example-owner/harness-sandbox", 12))?.id).toBe(a.id);
    expect((await store.findRequestByCard(-100, 55))?.id).toBe(a.id);
    expect((await store.listRequestsByState(["queued"])).map((r) => r.id)).toEqual([a.id]);
    const message = { chatId: -100, messageId: 56, requestId: a.id, kind: "question" };
    await store.recordMessage({ ...message, ref: { number: 12 } });
    await store.recordMessage({ ...message, ref: null });
    expect((await store.findMessage(-100, 56))?.ref).toEqual({ number: 12 });
  });
});
