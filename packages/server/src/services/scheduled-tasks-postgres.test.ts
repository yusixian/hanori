import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { readFile } from "node:fs/promises";
import { sql, eq } from "drizzle-orm";
import { createDb, scheduledTasks, scheduledTaskRuns } from "@cos-tool-bot/database";
import type { ScheduledTaskActor, ScheduledTaskPlan } from "@cos-tool-bot/shared";
import { ScheduledTaskService, type ScheduledTaskExecutor } from "./scheduled-tasks.js";
import type { Logger } from "pino";
const url = process.env.SCHEDULED_TASK_FIX_DATABASE_URL;
const botId = "11111111-1111-4111-8111-111111111111";
const actor: ScheduledTaskActor = {
  botId,
  chatId: -100,
  userId: 1,
  isAdmin: true,
  isBotAdmin: true,
};
const plan: ScheduledTaskPlan = {
  name: "Fixture",
  instructions: "Use approved plan",
  dataScope: { kind: "none" },
  destination: { chatId: -100 },
  schedule: {
    kind: "interval",
    startsAt: "2099-01-01T00:00:00Z",
    everySeconds: 86400,
    timezone: "Asia/Shanghai",
  },
  agent: {},
};
describe.runIf(Boolean(url))("scheduled task PostgreSQL migration and manual claims", () => {
  let conn: ReturnType<typeof createDb>,
    owns = false,
    legacyTask: string;
  const logger = { error: vi.fn() } as unknown as Logger;
  const service = (
    executor: ScheduledTaskExecutor = async () => ({ output: "done", agent: {}, messageIds: [42] }),
  ) => new ScheduledTaskService(conn.db, executor, vi.fn(), logger);
  async function migrate(name: string, db: Pick<typeof conn.db, "execute">) {
    const text = await readFile(
      new URL(`../../../database/drizzle/${name}.sql`, import.meta.url),
      "utf8",
    );
    for (const statement of text.split("--> statement-breakpoint"))
      await db.execute(sql.raw(statement));
  }
  beforeAll(async () => {
    const parsed = new URL(url!);
    if (
      !["127.0.0.1", "localhost", "[::1]"].includes(parsed.hostname) ||
      !parsed.pathname.endsWith("_test")
    )
      throw Error("Requires isolated local _test database");
    conn = createDb(url!);
    await conn.db.transaction(async (tx) => {
      await tx.execute(sql`CREATE TABLE bots (id uuid PRIMARY KEY)`);
      await tx.execute(sql`INSERT INTO bots(id) VALUES (${botId})`);
      await migrate("0072_illegal_loa", tx);
      await migrate("0073_next_hercules", tx);
      const [task] = await tx
        .insert(scheduledTasks)
        .values({ botId, chatId: -100, proposerId: 1, proposerName: "Fixture" })
        .returning();
      legacyTask = task!.id;
      await tx.execute(
        sql`INSERT INTO scheduled_task_runs(task_id,status,trial,scheduled_for,plan,agent) VALUES (${legacyTask},'succeeded',true,now(),${JSON.stringify(plan)}::json,'{}'::json)`,
      );
      await migrate("0075_vengeful_stepford_cuckoos", tx);
    });
    owns = true;
  });
  afterAll(async () => {
    if (conn) {
      if (owns) {
        await conn.db.execute(sql`DROP TABLE IF EXISTS scheduled_task_runs`);
        await conn.db.execute(sql`DROP TABLE IF EXISTS scheduled_tasks`);
        await conn.db.execute(sql`DROP TABLE bots`);
      }
      await conn.client.end();
    }
  });
  async function approved(s: ScheduledTaskService) {
    const task = await s.propose(actor, plan);
    return s.decide(actor, { id: task.id, version: 1, action: "approve" });
  }
  it("keeps historical trials distinguishable and adds empty receipts", async () => {
    const [run] = await conn.db
      .select()
      .from(scheduledTaskRuns)
      .where(eq(scheduledTaskRuns.taskId, legacyTask));
    expect(run).toMatchObject({ trial: true, manual: false, messageIds: [] });
  });
  it("allows only one concurrent manual claim and preserves schedule/failure count and receipts", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const execute = vi.fn(async () => {
      await gate;
      return { output: "done", agent: {}, messageIds: [42] };
    });
    const a = service(execute),
      b = service(execute);
    const task = await approved(a);
    await conn.db
      .update(scheduledTasks)
      .set({ consecutiveFailures: 2 })
      .where(eq(scheduledTasks.id, task.id));
    const results = await Promise.allSettled([a.runNow(actor, task.id), b.runNow(actor, task.id)]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(execute).toHaveBeenCalledOnce();
    expect((await a.get(actor, task.id))?.runningRunId).toBeTruthy();
    release();
    await a.close();
    await b.close();
    expect(await a.get(actor, task.id)).toMatchObject({
      nextRunAt: task.nextRunAt,
      consecutiveFailures: 2,
      status: "active",
      runningRunId: null,
    });
    expect((await a.runs(actor, task.id))[0]).toMatchObject({
      manual: true,
      trial: false,
      status: "succeeded",
      messageIds: [42],
    });
    expect((await a.listForPanel(botId)).find((t) => t.id === task.id)?.latestRun).toMatchObject({
      manual: true,
      messageIds: [42],
    });
  });
  it("serializes a due periodic claim against a manual claim without overlapping execution", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const execute = vi.fn(async () => {
      await gate;
      return { output: "done", agent: {} };
    });
    const a = service(execute),
      b = service(execute);
    const task = await approved(a);
    const past = new Date(Date.now() - 1000);
    await conn.db
      .update(scheduledTasks)
      .set({ nextRunAt: past })
      .where(eq(scheduledTasks.id, task.id));
    await Promise.allSettled([a.runNow(actor, task.id), b.tick()]);
    await vi.waitFor(() => expect(execute).toHaveBeenCalledOnce());
    expect(await a.runs(actor, task.id)).toHaveLength(1);
    release();
    await a.close();
    await b.close();
    const [run] = await a.runs(actor, task.id);
    const current = await a.get(actor, task.id);
    if (run!.manual) expect(current!.nextRunAt).toBe(past.toISOString());
    else expect(current!.nextRunAt).not.toBe(past.toISOString());
  });
  it("recovers an interrupted manual run without consuming its next periodic occurrence", async () => {
    const a = service();
    const task = await approved(a);
    const runId = crypto.randomUUID();
    await conn.db.insert(scheduledTaskRuns).values({
      id: runId,
      taskId: task.id,
      status: "running",
      trial: false,
      manual: true,
      scheduledFor: new Date(),
      plan,
      agent: {},
    });
    await conn.db
      .update(scheduledTasks)
      .set({ runningRunId: runId })
      .where(eq(scheduledTasks.id, task.id));
    await a.start();
    await a.close();
    expect(await a.get(actor, task.id)).toMatchObject({
      nextRunAt: task.nextRunAt,
      status: "active",
      runningRunId: null,
    });
    expect((await a.runs(actor, task.id))[0]?.status).toBe("interrupted");
  });
});
