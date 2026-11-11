import { scheduledTasks, scheduledTaskRuns, type Database } from "@cos-tool-bot/database";
import type {
  AgentExecutionConfig,
  ScheduledTaskActor,
  ScheduledTaskDecision,
  ScheduledTaskPlan,
  ScheduledTaskPort,
  ScheduledTaskRecord,
  ScheduledTaskRun,
  ScheduledTaskStatus,
} from "@cos-tool-bot/shared";
import { and, desc, eq, isNull, lte, gt, ne, or } from "drizzle-orm";
import { z } from "zod";
import type { Logger } from "pino";
import {
  nextTaskOccurrence,
  latestTaskOccurrence,
  validateTaskSchedule,
} from "./scheduled-task-calendar.js";

const agentSchema = z.object({
  providerId: z.string().optional(),
  modelId: z.string().optional(),
  systemPrompt: z.string().optional(),
  toolNames: z.array(z.string()).optional(),
  timeoutMs: z.number().int().min(1000).max(3_600_000).optional(),
  maxSteps: z.number().int().min(1).max(256).optional(),
});
const scheduleSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("once"), at: z.string(), timezone: z.string() }),
  z.object({
    kind: z.literal("interval"),
    startsAt: z.string(),
    everySeconds: z.number().int().positive(),
    timezone: z.string(),
  }),
  z.object({
    kind: z.literal("calendar"),
    startsAt: z.string(),
    timezone: z.string(),
    period: z.enum(["week", "month", "quarter"]),
    hour: z.number().int(),
    minute: z.number().int(),
    weekday: z.number().int().optional(),
    dayOfMonth: z.number().int().optional(),
  }),
]);
export class ScheduledTaskRequestError extends Error {}

export function parseScheduledTaskPlan(input: unknown): ScheduledTaskPlan {
  const plan = z
    .object({
      name: z.string().trim().min(1),
      instructions: z.string().trim().min(1),
      dataScope: z.object({
        kind: z.enum(["none", "chat"]),
        lookbackHours: z.number().positive().optional(),
        maxMessages: z.number().int().min(1).max(1000).optional(),
      }),
      destination: z.object({
        chatId: z.number().int().safe(),
        threadId: z.number().int().positive().optional(),
      }),
      schedule: scheduleSchema,
      agentName: z.string().optional(),
      agent: agentSchema,
    })
    .parse(input);
  try {
    validateTaskSchedule(plan.schedule);
  } catch (error) {
    throw new ScheduledTaskRequestError(
      error instanceof Error ? error.message : "Invalid schedule",
    );
  }
  return plan;
}
type Row = typeof scheduledTasks.$inferSelect;
export interface ScheduledTaskExecutorOptions {
  onAgentResolved?: (agent: AgentExecutionConfig) => Promise<void>;
  runId: string;
  signal: AbortSignal;
  trial: boolean;
}
export type ScheduledTaskExecutor = (
  task: ScheduledTaskRecord,
  plan: ScheduledTaskPlan,
  options: ScheduledTaskExecutorOptions,
) => Promise<{ output: string; agent: AgentExecutionConfig }>;
function record(row: Row): ScheduledTaskRecord {
  return {
    ...row,
    status: row.status as ScheduledTaskStatus,
    expiresAt: row.expiresAt?.toISOString() ?? null,
    nextRunAt: row.nextRunAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
  };
}
function scope(actor: ScheduledTaskActor) {
  return and(
    eq(scheduledTasks.botId, actor.botId),
    eq(scheduledTasks.chatId, actor.chatId),
    actor.threadId === undefined
      ? isNull(scheduledTasks.threadId)
      : eq(scheduledTasks.threadId, actor.threadId),
  );
}
export class ScheduledTaskService implements ScheduledTaskPort {
  private timer?: ReturnType<typeof setInterval>;
  private polling = false;
  private closing = false;
  private admitted = new Set<Promise<void>>();
  private failedResults = new Map<string, { taskId: string; revision: number; trial: boolean }>();
  private executions = new Map<string, { controller: AbortController; promise: Promise<void> }>();
  constructor(
    private db: Database,
    private executor: ScheduledTaskExecutor,
    private notifyFailure: (task: ScheduledTaskRecord, error: string) => Promise<void>,
    private logger: Logger,
  ) {}
  async listForPanel(botId?: string) {
    return (
      await this.db
        .select()
        .from(scheduledTasks)
        .where(botId ? eq(scheduledTasks.botId, botId) : undefined)
        .orderBy(desc(scheduledTasks.createdAt))
    ).map(record);
  }
  async getForPanel(id: string) {
    const [row] = await this.db.select().from(scheduledTasks).where(eq(scheduledTasks.id, id));
    return row ? record(row) : null;
  }
  async get(actor: ScheduledTaskActor, id: string) {
    const [row] = await this.db
      .select()
      .from(scheduledTasks)
      .where(and(scope(actor), eq(scheduledTasks.id, id)));
    return row ? record(row) : null;
  }
  async list(actor: ScheduledTaskActor) {
    return (
      await this.db
        .select()
        .from(scheduledTasks)
        .where(scope(actor))
        .orderBy(desc(scheduledTasks.createdAt))
    ).map(record);
  }
  async runs(actor: ScheduledTaskActor, id: string): Promise<ScheduledTaskRun[]> {
    if (!(await this.get(actor, id))) return [];
    return (
      await this.db
        .select()
        .from(scheduledTaskRuns)
        .where(eq(scheduledTaskRuns.taskId, id))
        .orderBy(desc(scheduledTaskRuns.startedAt))
        .limit(100)
    ).map((row) => ({
      ...row,
      status: row.status as ScheduledTaskRun["status"],
      scheduledFor: row.scheduledFor.toISOString(),
      startedAt: row.startedAt.toISOString(),
      finishedAt: row.finishedAt?.toISOString() ?? null,
    }));
  }
  async getPendingDiscussion(actor: ScheduledTaskActor, replyToMessageId?: number) {
    const rows = await this.db
      .select()
      .from(scheduledTasks)
      .where(
        and(
          scope(actor),
          replyToMessageId === undefined
            ? eq(scheduledTasks.proposerId, actor.userId)
            : eq(scheduledTasks.confirmationMessageId, replyToMessageId),
        ),
      )
      .orderBy(desc(scheduledTasks.createdAt));
    const row = rows.find((row) => row.pendingPlan && row.expiresAt && row.expiresAt > new Date());
    return row ? record(row) : null;
  }
  async propose(actor: ScheduledTaskActor, plan: ScheduledTaskPlan, taskId?: string) {
    plan = parseScheduledTaskPlan(plan);
    if (!Number.isSafeInteger(plan.destination.chatId))
      throw new ScheduledTaskRequestError("Invalid destination");
    const expiresAt = new Date(Date.now() + 24 * 3_600_000);
    if (!taskId) {
      const [row] = await this.db
        .insert(scheduledTasks)
        .values({
          botId: actor.botId,
          chatId: actor.chatId,
          threadId: actor.threadId,
          proposerId: actor.userId,
          proposerName: actor.userName ?? String(actor.userId),
          pendingPlan: plan,
          pendingVersion: 1,
          expiresAt,
        })
        .returning();
      return record(row!);
    }
    const existing = await this.get(actor, taskId);
    if (!existing || existing.status === "cancelled")
      throw new ScheduledTaskRequestError("Task not found");
    const version = Math.max(existing.revision, existing.pendingVersion ?? 0) + 1;
    const [row] = await this.db
      .update(scheduledTasks)
      .set({
        pendingPlan: plan,
        pendingVersion: version,
        expiresAt,
        confirmationMessageId: null,
        proposerId: actor.userId,
        proposerName: actor.userName ?? String(actor.userId),
      })
      .where(
        and(
          scope(actor),
          eq(scheduledTasks.id, taskId),
          eq(scheduledTasks.revision, existing.revision),
          eq(scheduledTasks.status, existing.status),
          existing.pendingVersion === null
            ? isNull(scheduledTasks.pendingVersion)
            : eq(scheduledTasks.pendingVersion, existing.pendingVersion),
        ),
      )
      .returning();
    if (!row) throw new ScheduledTaskRequestError("Plan changed; reload before editing");
    return record(row);
  }
  async bindConfirmation(
    actor: ScheduledTaskActor,
    id: string,
    version: number,
    messageId: number,
  ) {
    const rows = await this.db
      .update(scheduledTasks)
      .set({ confirmationMessageId: messageId })
      .where(
        and(scope(actor), eq(scheduledTasks.id, id), eq(scheduledTasks.pendingVersion, version)),
      )
      .returning({ id: scheduledTasks.id });
    if (!rows.length) throw new ScheduledTaskRequestError("Plan changed");
  }
  async decide(actor: ScheduledTaskActor, decision: ScheduledTaskDecision) {
    if (!actor.isAdmin) throw new ScheduledTaskRequestError("Administrator approval required");
    const task = await this.get(actor, decision.id);
    if (
      !task?.pendingPlan ||
      task.pendingVersion !== decision.version ||
      !task.expiresAt ||
      new Date(task.expiresAt) <= new Date() ||
      (decision.messageId !== undefined && task.confirmationMessageId !== decision.messageId)
    )
      throw new ScheduledTaskRequestError("Confirmation expired or plan changed");
    if (!actor.isBotAdmin && task.pendingPlan.destination.chatId !== actor.chatId)
      throw new ScheduledTaskRequestError("Cross-chat destination requires Bot administrator");
    if (decision.action === "trial") {
      await this.execute(
        { ...task, approvedByUserId: actor.userId },
        task.pendingPlan,
        true,
        decision.version,
      );
      return (await this.get(actor, task.id))!;
    }
    const changes =
      decision.action === "approve"
        ? {
            approvedByUserId: actor.userId,
            activePlan: task.pendingPlan,
            revision: decision.version,
            status: "active",
            nextRunAt: nextTaskOccurrence(task.pendingPlan.schedule, new Date(0)),
            consecutiveFailures: 0,
          }
        : { status: task.activePlan ? task.status : "cancelled" };
    const [row] = await this.db
      .update(scheduledTasks)
      .set({
        ...changes,
        pendingPlan: null,
        pendingVersion: null,
        expiresAt: null,
        confirmationMessageId: null,
      })
      .where(
        and(
          scope(actor),
          eq(scheduledTasks.id, task.id),
          eq(scheduledTasks.pendingVersion, decision.version),
          gt(scheduledTasks.expiresAt, new Date()),
          ...(decision.messageId === undefined
            ? []
            : [eq(scheduledTasks.confirmationMessageId, decision.messageId)]),
        ),
      )
      .returning();
    if (!row) throw new ScheduledTaskRequestError("Confirmation already handled");
    return record(row);
  }
  async manage(actor: ScheduledTaskActor, id: string, action: "pause" | "resume" | "cancel") {
    if (!actor.isAdmin) throw new ScheduledTaskRequestError("Administrator permission required");
    const task = await this.get(actor, id);
    if (!task || task.status === "cancelled" || !task.activePlan)
      throw new ScheduledTaskRequestError("Active task not found");
    if (action === "pause" && task.status !== "active")
      throw new ScheduledTaskRequestError("Only active tasks can be paused");
    if (action === "resume" && task.status !== "paused")
      throw new ScheduledTaskRequestError("Only paused tasks can be resumed");
    const [row] = await this.db
      .update(scheduledTasks)
      .set({
        status: action === "resume" ? "active" : action === "pause" ? "paused" : "cancelled",
        ...(action === "resume"
          ? {
              nextRunAt:
                task.activePlan.schedule.kind === "once"
                  ? new Date(task.activePlan.schedule.at)
                  : nextTaskOccurrence(task.activePlan.schedule, new Date()),
              consecutiveFailures: 0,
            }
          : {}),
        ...(action === "cancel"
          ? { pendingPlan: null, pendingVersion: null, confirmationMessageId: null }
          : {}),
      })
      .where(
        and(
          scope(actor),
          eq(scheduledTasks.id, id),
          eq(scheduledTasks.status, task.status),
          eq(scheduledTasks.revision, task.revision),
        ),
      )
      .returning();
    if (!row) throw new ScheduledTaskRequestError("Task changed; reload before managing");
    if (action !== "resume" && task.runningRunId)
      this.executions.get(task.runningRunId)?.controller.abort();
    return record(row!);
  }
  async start() {
    if (this.timer) return;
    // A prior process may have sent content before dying. Do not replay that unknown outcome.
    const unfinished = await this.db.select().from(scheduledTasks);
    for (const task of unfinished.filter((row) => row.runningRunId)) {
      await this.db.transaction(async (tx) => {
        const [interrupted] = await tx
          .select()
          .from(scheduledTaskRuns)
          .where(eq(scheduledTaskRuns.id, task.runningRunId!));
        await tx
          .update(scheduledTaskRuns)
          .set({
            status: "interrupted",
            finishedAt: new Date(),
            error: "Process stopped during execution; outcome may be partial",
          })
          .where(
            and(
              eq(scheduledTaskRuns.id, task.runningRunId!),
              eq(scheduledTaskRuns.status, "running"),
            ),
          );
        await tx
          .update(scheduledTasks)
          .set({
            runningRunId: null,
            nextRunAt: interrupted?.trial
              ? task.nextRunAt
              : task.activePlan
                ? nextTaskOccurrence(task.activePlan.schedule, new Date(Date.now() + 1))
                : null,
            status:
              !interrupted?.trial &&
              task.status === "active" &&
              task.activePlan?.schedule.kind === "once"
                ? "completed"
                : task.status,
          })
          .where(eq(scheduledTasks.id, task.id));
      });
    }
    this.closing = false;
    this.timer = setInterval(() => {
      void this.tick().catch((error) => this.logger.error(error, "Scheduled task polling failed"));
    }, 1000);
    this.timer.unref();
    await this.tick();
  }
  async tick() {
    if (this.polling || this.closing) return;
    this.polling = true;
    try {
      await this.recoverFailedResults();
      const due = await this.db
        .select()
        .from(scheduledTasks)
        .where(
          and(
            eq(scheduledTasks.status, "active"),
            isNull(scheduledTasks.runningRunId),
            lte(scheduledTasks.nextRunAt, new Date()),
          ),
        );
      for (const row of due)
        if (row.activePlan)
          void this.execute(record(row), row.activePlan, false).catch((error) =>
            this.logger.error(error, "Scheduled task execution failed"),
          );
    } finally {
      this.polling = false;
    }
  }
  private execute(
    task: ScheduledTaskRecord,
    plan: ScheduledTaskPlan,
    trial: boolean,
    version?: number,
  ): Promise<void> {
    const operation = this.executeImpl(task, plan, trial, version);
    this.admitted.add(operation);
    void operation.finally(() => this.admitted.delete(operation)).catch(() => {});
    return operation;
  }
  private async executeImpl(
    task: ScheduledTaskRecord,
    plan: ScheduledTaskPlan,
    trial: boolean,
    version?: number,
  ) {
    if (this.closing) throw new ScheduledTaskRequestError("Scheduler is stopping");
    const runId = crypto.randomUUID(),
      now = new Date();
    const claimed = await this.db.transaction(async (tx) => {
      const [row] = await tx
        .update(scheduledTasks)
        .set({ runningRunId: runId, ...(trial ? { lastTrialVersion: version } : {}) })
        .where(
          and(
            eq(scheduledTasks.id, task.id),
            eq(scheduledTasks.revision, task.revision),
            isNull(scheduledTasks.runningRunId),
            trial
              ? and(
                  eq(scheduledTasks.pendingVersion, version!),
                  gt(scheduledTasks.expiresAt, now),
                  or(
                    isNull(scheduledTasks.lastTrialVersion),
                    ne(scheduledTasks.lastTrialVersion, version!),
                  ),
                )
              : and(eq(scheduledTasks.status, "active"), lte(scheduledTasks.nextRunAt, now)),
          ),
        )
        .returning();
      if (!row) return false;
      await tx.insert(scheduledTaskRuns).values({
        id: runId,
        taskId: task.id,
        status: "running",
        trial,
        scheduledFor: trial
          ? now
          : (latestTaskOccurrence(plan.schedule, now) ?? new Date(task.nextRunAt!)),
        plan,
        agent: plan.agent,
      });
      return true;
    });
    if (!claimed) {
      if (trial) throw new ScheduledTaskRequestError("Trial already started or task is running");
      return;
    }
    const controller = new AbortController();
    if (this.closing) controller.abort();
    const promise = this.perform(task, plan, runId, trial, controller.signal);
    this.executions.set(runId, { controller, promise });
    this.admitted.add(promise);
    void promise
      .finally(() => {
        this.executions.delete(runId);
        this.admitted.delete(promise);
      })
      .catch((error) => {
        this.failedResults.set(runId, { taskId: task.id, revision: task.revision, trial });
        this.logger.error(error, "Scheduled task result persistence failed");
      });
  }
  private async recoverFailedResults() {
    // Only settled executions enter this map; a claim awaiting registration is never treated as orphaned.
    for (const [runId, failed] of this.failedResults) {
      await this.db.transaction(async (tx) => {
        const [task] = await tx
          .select()
          .from(scheduledTasks)
          .where(and(eq(scheduledTasks.id, failed.taskId), eq(scheduledTasks.runningRunId, runId)))
          .for("update");
        if (!task) return;
        await tx
          .update(scheduledTaskRuns)
          .set({
            status: "interrupted",
            finishedAt: new Date(),
            error: "Execution ended but its result could not be saved; outcome may be partial",
          })
          .where(and(eq(scheduledTaskRuns.id, runId), eq(scheduledTaskRuns.status, "running")));
        const samePlan = !failed.trial && task.revision === failed.revision;
        const next = task.activePlan
          ? nextTaskOccurrence(task.activePlan.schedule, new Date(Date.now() + 1))
          : null;
        await tx
          .update(scheduledTasks)
          .set({
            runningRunId: null,
            ...(samePlan
              ? {
                  nextRunAt: next,
                  status: task.status === "active" && !next ? "completed" : task.status,
                }
              : {}),
          })
          .where(
            and(
              eq(scheduledTasks.id, task.id),
              eq(scheduledTasks.runningRunId, runId),
              eq(scheduledTasks.revision, task.revision),
              eq(scheduledTasks.status, task.status),
            ),
          );
      });
      this.failedResults.delete(runId);
    }
  }
  private async perform(
    task: ScheduledTaskRecord,
    plan: ScheduledTaskPlan,
    runId: string,
    trial: boolean,
    signal: AbortSignal,
  ) {
    let output: string | null = null,
      error: string | null = null,
      agent = plan.agent;
    try {
      const result = await this.executor(task, plan, {
        runId,
        signal,
        trial,
        onAgentResolved: async (resolved) => {
          agent = resolved;
          await this.db
            .update(scheduledTaskRuns)
            .set({ agent: resolved })
            .where(eq(scheduledTaskRuns.id, runId));
        },
      });
      output = result.output;
      agent = result.agent;
    } catch (failure) {
      error = failure instanceof Error ? failure.message : String(failure);
    }
    const failures = error ? task.consecutiveFailures + 1 : 0;
    let paused = false;
    await this.db.transaction(async (tx) => {
      await tx
        .update(scheduledTaskRuns)
        .set({
          status: error ? "failed" : "succeeded",
          finishedAt: new Date(),
          output,
          error,
          agent,
        })
        .where(eq(scheduledTaskRuns.id, runId));
      const [current] = await tx
        .select()
        .from(scheduledTasks)
        .where(eq(scheduledTasks.id, task.id))
        .for("update");
      if (!current) return;
      paused =
        !trial &&
        current.revision === task.revision &&
        current.status === "active" &&
        failures >= 3;
      const next = current.activePlan
        ? nextTaskOccurrence(current.activePlan.schedule, new Date(Date.now() + 1))
        : null;
      await tx
        .update(scheduledTasks)
        .set({
          runningRunId: null,
          ...(!trial && current.revision === task.revision
            ? {
                nextRunAt: next,
                consecutiveFailures: failures,
                status:
                  current.status !== "active"
                    ? current.status
                    : failures >= 3
                      ? "paused"
                      : next
                        ? "active"
                        : "completed",
              }
            : {}),
        })
        .where(and(eq(scheduledTasks.id, task.id), eq(scheduledTasks.runningRunId, runId)));
    });
    if (paused && error) await this.notifyFailure(task, error);
  }
  async close() {
    this.closing = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    for (const run of this.executions.values()) run.controller.abort();
    while (this.admitted.size) await Promise.allSettled(this.admitted);
  }
}
