import { getTableColumns, getTableName, type SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import type { Database } from "@cos-tool-bot/database";
import type { ScheduledTaskActor, ScheduledTaskPlan } from "@cos-tool-bot/shared";
import type { Logger } from "pino";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ScheduledTaskService, type ScheduledTaskExecutorOptions } from "./scheduled-tasks.js";

function memoryDatabase() {
  const tables = new Map<string, Record<string, unknown>[]>();
  const rows = (table: any) => {
    const name = getTableName(table);
    if (!tables.has(name)) tables.set(name, []);
    return tables.get(name)!;
  };
  const matches = (table: any, row: Record<string, unknown>, condition?: SQL) => {
    if (!condition) return true;
    const query = new PgDialect().sqlToQuery(condition);
    const columns = Object.entries(getTableColumns(table)).map(([key, col]) => [
      (col as { name: string }).name,
      key,
    ]);
    let expression = query.sql
      .replace(
        /"[^"]+"\."([^"]+)"/g,
        (_, column) => `row[${JSON.stringify(columns.find(([name]) => name === column)![1])}]`,
      )
      .replace(/\$(\d+)/g, (_, index) => `params[${Number(index) - 1}]`)
      .replace(/ is null/g, " == null")
      .replace(/ is not null/g, " != null")
      .replace(/ and /g, " && ")
      .replace(/ or /g, " || ")
      .replace(/ = /g, " === ")
      .replace(/ <> /g, " !== ");
    // This evaluates only SQL emitted by Drizzle from these test fixtures, never external input.
    return new Function("row", "params", `return ${expression}`)(
      row,
      query.params.map((value) =>
        typeof value === "string" && /^\d{4}-\d{2}-\d{2}T/.test(value) ? new Date(value) : value,
      ),
    );
  };
  const chain = (result: () => any[]) => {
    const q: any = {
      where: (condition: SQL) => {
        q.condition = condition;
        return q;
      },
      orderBy: () => q,
      for: () => q,
      limit: () => q,
      returning: () => Promise.resolve(result()),
      // Drizzle queries are awaitable builders.
      // oxlint-disable-next-line unicorn/no-thenable
      then: (resolve: any, reject: any) => Promise.resolve(result()).then(resolve, reject),
    };
    return q;
  };
  const db: any = {
    select: () => ({
      from: (table: any) => {
        const q = chain(() => rows(table).filter((row) => matches(table, row, q.condition)));
        return q;
      },
    }),
    insert: (table: any) => ({
      values: (value: any) => {
        const q = chain(() => {
          const row = {
            id: crypto.randomUUID(),
            createdAt: new Date(),
            startedAt: new Date(),
            status: "pending",
            revision: 0,
            pendingVersion: null,
            lastTrialVersion: null,
            approvedByUserId: null,
            expiresAt: null,
            confirmationMessageId: null,
            activePlan: null,
            pendingPlan: null,
            nextRunAt: null,
            runningRunId: null,
            consecutiveFailures: 0,
            threadId: null,
            finishedAt: null,
            output: null,
            error: null,
            ...value,
          };
          rows(table).push(row);
          return [row];
        });
        return q;
      },
    }),
    update: (table: any) => ({
      set: (value: any) => {
        const q = chain(() => {
          const found = rows(table).filter((row) => matches(table, row, q.condition));
          found.forEach((row) => Object.assign(row, value));
          return found;
        });
        return q;
      },
    }),
    transaction: (fn: any) => fn(db),
  };
  return { db: db as Database, tables };
}
const actor: ScheduledTaskActor = {
  botId: "00000000-0000-4000-8000-000000000001",
  chatId: -10,
  userId: 2,
  isAdmin: false,
};
const admin = { ...actor, userId: 1, isAdmin: true, isBotAdmin: true };
const plan: ScheduledTaskPlan = {
  name: "weekly summary",
  instructions: "summarize",
  dataScope: { kind: "chat" },
  destination: { chatId: -10 },
  schedule: {
    kind: "interval",
    startsAt: "2026-01-01T00:00:00Z",
    everySeconds: 3600,
    timezone: "UTC",
  },
  agent: {},
};
function setup(execute = vi.fn().mockResolvedValue({ output: "done", agent: {} })) {
  const { db, tables } = memoryDatabase(),
    notify = vi.fn();
  const service = new ScheduledTaskService(db, execute, notify, {
    error: vi.fn(),
  } as unknown as Logger);
  return { service, execute, notify, tables, db };
}
async function approved(s: ReturnType<typeof setup>) {
  const task = await s.service.propose(actor, plan);
  await s.service.bindConfirmation(actor, task.id, 1, 100);
  return s.service.decide(admin, { id: task.id, version: 1, messageId: 100, action: "approve" });
}
async function settle() {
  for (let i = 0; i < 30; i++) await Promise.resolve();
}
describe("durable scheduled tasks", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T03:30:00Z"));
  });
  afterEach(() => vi.useRealTimers());
  it("runs the approved plan manually without changing schedule or pending edits", async () => {
    const s = setup();
    const task = await approved(s);
    const pending = await s.service.propose(
      actor,
      { ...plan, instructions: "Unapproved edit" },
      task.id,
    );
    await s.service.runNow(admin, task.id);
    await settle();
    expect(s.execute.mock.calls[0]?.[1].instructions).toBe(plan.instructions);
    expect(await s.service.get(actor, task.id)).toMatchObject({
      nextRunAt: task.nextRunAt,
      pendingVersion: pending.pendingVersion,
      status: "active",
      consecutiveFailures: 0,
    });
    expect((await s.service.runs(actor, task.id))[0]).toMatchObject({
      manual: true,
      trial: false,
      status: "succeeded",
    });
  });
  it("rejects unapproved, cancelled, non-admin and cross-Bot manual execution", async () => {
    const s = setup();
    const pending = await s.service.propose(actor, plan);
    await expect(s.service.runNow(admin, pending.id)).rejects.toThrow("Approved");
    const task = await approved(s);
    await expect(s.service.runNow(actor, task.id)).rejects.toThrow("Administrator");
    await expect(s.service.runNow({ ...admin, botId: "other" }, task.id)).rejects.toThrow(
      "Approved",
    );
    await s.service.manage(admin, task.id, "cancel");
    await expect(s.service.runNow(admin, task.id)).rejects.toThrow("Approved");
    expect(s.execute).not.toHaveBeenCalled();
  });
  it("allows a completed approved one-shot to run manually without rescheduling it", async () => {
    const s = setup();
    const proposal = await s.service.propose(actor, {
      ...plan,
      schedule: { kind: "once", at: "2026-01-01T00:00:00Z", timezone: "UTC" },
    });
    await s.service.decide(admin, { id: proposal.id, version: 1, action: "approve" });
    await s.service.tick();
    await settle();
    await s.service.runNow(admin, proposal.id);
    await settle();
    expect(s.execute).toHaveBeenCalledTimes(2);
    expect(await s.service.get(actor, proposal.id)).toMatchObject({
      status: "completed",
      nextRunAt: null,
    });
  });
  it("manual failure does not pause the schedule or consume the next occurrence", async () => {
    const s = setup(vi.fn().mockRejectedValue(new Error("Fixture failure")));
    const task = await approved(s);
    for (let i = 0; i < 3; i++) {
      await s.service.runNow(admin, task.id);
      await settle();
    }
    expect(await s.service.get(actor, task.id)).toMatchObject({
      status: "active",
      nextRunAt: task.nextRunAt,
      consecutiveFailures: 0,
    });
    expect(s.notify).not.toHaveBeenCalled();
    expect((await s.service.runs(actor, task.id))[0]?.status).toBe("failed");
  });
  it("requires admin and the displayed version; repeating confirmation does not create another task", async () => {
    const s = setup();
    const task = await s.service.propose(actor, plan);
    await s.service.bindConfirmation(actor, task.id, 1, 100);
    await expect(
      s.service.decide(actor, { id: task.id, version: 1, messageId: 100, action: "approve" }),
    ).rejects.toThrow("Administrator");
    await expect(
      s.service.decide(admin, { id: task.id, version: 1, messageId: 101, action: "approve" }),
    ).rejects.toThrow("changed");
    await s.service.decide(admin, { id: task.id, version: 1, messageId: 100, action: "approve" });
    await expect(
      s.service.decide(admin, { id: task.id, version: 1, messageId: 100, action: "approve" }),
    ).rejects.toThrow();
    expect(await s.service.list(actor)).toHaveLength(1);
    expect(await s.service.get({ ...actor, chatId: -11 }, task.id)).toBeNull();
  });
  it("trial runs only once for a plan version and never enables its schedule", async () => {
    const s = setup();
    const task = await s.service.propose(actor, plan);
    await s.service.decide(admin, { id: task.id, version: 1, action: "trial" });
    expect((await s.service.get(actor, task.id))?.status).toBe("pending");
    expect(s.execute).toHaveBeenCalledOnce();
    await expect(
      s.service.decide(admin, { id: task.id, version: 1, action: "trial" }),
    ).rejects.toThrow("already");
    expect((await s.service.runs(actor, task.id))[0]?.trial).toBe(true);
  });
  it("returns a running trial immediately and close drains its completion", async () => {
    let finish!: (value: { output: string; agent: {} }) => void;
    const execute = vi.fn(
      () =>
        new Promise<{ output: string; agent: {} }>((resolve) => {
          finish = resolve;
        }),
    );
    const s = setup(execute);
    const task = await s.service.propose(actor, plan);
    const trial = await s.service.decide(admin, { id: task.id, version: 1, action: "trial" });
    expect(trial.runningRunId).not.toBeNull();
    expect((await s.service.runs(actor, task.id))[0]?.status).toBe("running");
    const close = s.service.close();
    finish({ output: "trial complete", agent: {} });
    await close;
    expect((await s.service.runs(actor, task.id))[0]?.output).toBe("trial complete");
  });
  it("resumes an overdue paused one-shot exactly once", async () => {
    const s = setup();
    const task = await s.service.propose(actor, {
      ...plan,
      schedule: { kind: "once", at: "2026-01-01T04:00:00Z", timezone: "UTC" },
    });
    await s.service.decide(admin, { id: task.id, version: 1, action: "approve" });
    await s.service.manage(admin, task.id, "pause");
    vi.setSystemTime(new Date("2026-01-02T00:00:00Z"));
    await s.service.manage(admin, task.id, "resume");
    await s.service.tick();
    await settle();
    expect(s.execute).toHaveBeenCalledOnce();
    expect((await s.service.get(actor, task.id))?.status).toBe("completed");
    await expect(s.service.manage(admin, task.id, "resume")).rejects.toThrow("paused");
  });
  it("does not revive a cancelled task when resume or plan editing reads stale state", async () => {
    const s = setup();
    const task = await approved(s);
    await s.service.manage(admin, task.id, "pause");
    const get = s.service.get.bind(s.service);
    vi.spyOn(s.service, "get").mockImplementationOnce(async (actor, id) => {
      const snapshot = await get(actor, id);
      s.tables.get("scheduled_tasks")![0]!.status = "cancelled";
      return snapshot;
    });
    await expect(s.service.manage(admin, task.id, "resume")).rejects.toThrow("changed");
    expect((await get(actor, task.id))?.status).toBe("cancelled");
    s.tables.get("scheduled_tasks")![0]!.status = "active";
    vi.spyOn(s.service, "get").mockImplementationOnce(async (actor, id) => {
      const snapshot = await get(actor, id);
      s.tables.get("scheduled_tasks")![0]!.status = "cancelled";
      return snapshot;
    });
    await expect(s.service.propose(actor, plan, task.id)).rejects.toThrow("changed");
    expect((await get(actor, task.id))?.pendingPlan).toBeNull();
  });
  it("does not let pause turn a completed one-shot back into a runnable task", async () => {
    const s = setup();
    const task = await approved(s);
    s.tables.get("scheduled_tasks")![0]!.status = "completed";
    await expect(s.service.manage(admin, task.id, "pause")).rejects.toThrow("active");
    expect((await s.service.get(actor, task.id))?.status).toBe("completed");
  });
  it("records the resolved Agent even when its execution fails", async () => {
    const effective = { providerId: "provider-a", modelId: "model-a", toolNames: ["search"] };
    const execute = vi.fn(async (_task, _plan, options: ScheduledTaskExecutorOptions) => {
      await options.onAgentResolved?.(effective);
      throw new Error("model failed");
    });
    const s = setup(execute);
    const task = await approved(s);
    await s.service.tick();
    await settle();
    const run = (await s.service.runs(actor, task.id))[0];
    expect(run?.status).toBe("failed");
    expect(run?.agent).toEqual(effective);
  });
  it("recovers a failed result write on the next tick without replaying side effects", async () => {
    const s = setup();
    const task = await approved(s);
    const transaction = s.db.transaction.bind(s.db);
    let calls = 0;
    vi.spyOn(s.db, "transaction").mockImplementation((callback: any) => {
      if (++calls === 2) return Promise.reject(new Error("database temporarily unavailable"));
      return transaction(callback);
    });
    await s.service.tick();
    await settle();
    expect((await s.service.get(actor, task.id))?.runningRunId).not.toBeNull();
    await s.service.tick();
    await settle();
    expect((await s.service.get(actor, task.id))?.runningRunId).toBeNull();
    expect((await s.service.runs(actor, task.id))[0]?.status).toBe("interrupted");
    expect(s.execute).toHaveBeenCalledOnce();
    expect((await s.service.get(actor, task.id))?.nextRunAt).toBe("2026-01-01T04:00:00.000Z");
  });
  it("coalesces missed periods to one run and advances to a future deadline", async () => {
    const s = setup();
    const task = await approved(s);
    await s.service.tick();
    await settle();
    expect(s.execute).toHaveBeenCalledOnce();
    expect((await s.service.runs(actor, task.id))[0]?.scheduledFor).toBe(
      "2026-01-01T03:00:00.000Z",
    );
    expect((await s.service.get(actor, task.id))?.nextRunAt).toBe("2026-01-01T04:00:00.000Z");
  });
  it("does not overlap and keeps old approved plan while a change awaits approval", async () => {
    let finish!: (x: any) => void;
    const s = setup(
      vi.fn().mockImplementation(
        () =>
          new Promise((resolve) => {
            finish = resolve;
          }),
      ),
    );
    const task = await approved(s);
    await s.service.propose(actor, { ...plan, instructions: "new plan" }, task.id);
    await s.service.tick();
    await settle();
    await s.service.tick();
    await settle();
    expect(s.execute).toHaveBeenCalledOnce();
    expect(s.execute.mock.calls[0]![1].instructions).toBe("summarize");
    finish({ output: "done", agent: {} });
    await settle();
  });
  it("records failures, continues later periods and pauses after three consecutive failures", async () => {
    const s = setup(vi.fn().mockRejectedValue(new Error("upstream failure")));
    const task = await approved(s);
    for (let i = 0; i < 3; i++) {
      await s.service.tick();
      await settle();
      vi.setSystemTime(new Date(Date.now() + 3600_000));
    }
    expect((await s.service.get(actor, task.id))?.status).toBe("paused");
    expect(await s.service.runs(actor, task.id)).toHaveLength(3);
    expect(s.notify).toHaveBeenCalledOnce();
  });
  it("marks an interrupted run without replaying uncertain side effects after restart", async () => {
    const s = setup();
    const task = await approved(s);
    const row = s.tables.get("scheduled_tasks")![0]!;
    row.runningRunId = "run-1";
    s.tables.set("scheduled_task_runs", [
      {
        id: "run-1",
        taskId: task.id,
        status: "running",
        trial: false,
        plan,
        agent: {},
        startedAt: new Date(),
        scheduledFor: new Date(),
        finishedAt: null,
        output: null,
        error: null,
      },
    ]);
    await s.service.start();
    await settle();
    expect(s.execute).not.toHaveBeenCalled();
    expect((await s.service.runs(actor, task.id))[0]?.status).toBe("interrupted");
    expect((await s.service.get(actor, task.id))?.nextRunAt).toBe("2026-01-01T04:00:00.000Z");
    await s.service.close();
  });
  it("rejects expired approval and cross-chat delegated approval", async () => {
    const s = setup();
    const task = await s.service.propose(actor, { ...plan, destination: { chatId: -99 } });
    await expect(
      s.service.decide(
        { ...admin, isBotAdmin: false },
        { id: task.id, version: 1, action: "approve" },
      ),
    ).rejects.toThrow("Cross-chat");
    vi.setSystemTime(new Date(Date.now() + 25 * 3600_000));
    await expect(
      s.service.decide(admin, { id: task.id, version: 1, action: "approve" }),
    ).rejects.toThrow("expired");
  });
});
