import {
  type AgentConfigInfo,
  effortConfigOption,
  modelCatalog,
  resolveWorkerExecution,
} from "./config/execution.js";
import type { ProjectEffectiveConfig } from "./config/schema.js";
import { durationMs } from "./config/units.js";
import { type LodyMachine, findMachine } from "./lody.js";
import { errorText } from "./pr-actions.js";
import { quotaBlocks, quotaSnapshot, startOfDay } from "./quota.js";
import { pollJobs, warnQuota } from "./job-monitor.js";
import { QueueWatch } from "./queue-watch.js";
import { HarnessReconciler } from "./reconcile.js";
import {
  ACTIVE_STATES,
  AREA_HOLDING_STATES,
  JOB_STATES,
  REQUEST_STATES as S,
  areasConflict,
  requestAreas,
} from "./states.js";
import type { HarnessRequestRecord } from "./store.js";
import type { HarnessWork } from "./work.js";
import type { HarnessJobRecord } from "./work-store.js";

const TICK_MS = 10_000;
/** Covers `session create`; a `starting` job older than this is treated as lost. */
const START_LEASE_MS = 5 * 60_000;
const MAX_START_ATTEMPTS = 3;

/** Session titles become a CLI argument: single line, bounded. */
export function sessionTitle(
  projectKey: string,
  request: Pick<HarnessRequestRecord, "issueNumber" | "title"> & { type?: string },
): string {
  const ref = request.type === "task" ? "task" : `#${request.issueNumber ?? "?"}`;
  const raw = `${projectKey} ${ref} ${request.title ?? ""}`;
  // eslint-disable-next-line no-control-regex
  const flat = raw.replace(/[\u0000-\u001f\u007f\u2028\u2029]+/g, " ").replace(/\s+/g, " ");
  return flat.trim().slice(0, 100);
}

export interface MachineChoice {
  machineKey: string;
  machine: LodyMachine;
  provider: string;
  agent: string;
  model: string | null;
  effort: string | null;
  note: string | null;
}

interface Load {
  perMachine: Map<string, number>;
  perProject: Map<string, number>;
  holders: HarnessRequestRecord[];
  today: number;
}

function increment(map: Map<string, number>, key: string) {
  map.set(key, (map.get(key) ?? 0) + 1);
}

export interface WaitReason {
  reason: string;
  /** No execution machine is reachable at all, as opposed to a deliberate limit. */
  offline: boolean;
}

/** Picks a machine for the worker role, or explains why the request must keep waiting. */
export function chooseMachine(
  config: ProjectEffectiveConfig,
  machines: readonly LodyMachine[],
  perMachine: ReadonlyMap<string, number>,
  agents: readonly AgentConfigInfo[] | null = null,
): MachineChoice | WaitReason {
  const lead = resolveWorkerExecution(config, agents);
  const { agent, vendor: provider } = lead;
  const keys =
    config.project.machines.length > 0 ? config.project.machines : Object.keys(config.machines);
  const reasons: string[] = [];
  let anyOnline = false;
  for (const key of keys) {
    const entry = config.machines[key];
    if (!entry?.enabled) continue;
    const machine = findMachine(machines, entry.lody);
    if (!machine?.online) {
      reasons.push(`${entry.lody} 不在线`);
      continue;
    }
    anyOnline = true;
    if ((perMachine.get(key) ?? 0) >= config.guardrails.concurrency.perMachine) {
      reasons.push(`${entry.lody} 并发已满`);
      continue;
    }
    let model = lead.model;
    let effort = lead.effort;
    let note: string | null = null;
    const blocks = quotaBlocks(machine, provider, model, config.guardrails.quota.pauseAt);
    if (blocks.length > 0) {
      const fallback = config.guardrails.quota.fallback.worker;
      const block = blocks[0]!;
      const detail = `${provider} ${block.span === "week" ? "本周" : "5 小时"} ${block.usedPercent}% ≥ ${block.threshold}%`;
      if (!fallback) {
        reasons.push(`${entry.lody} 额度暂停（${detail}）`);
        continue;
      }
      note = `额度 ${detail}，改用 ${fallback}`;
      model = fallback;
      const option = modelCatalog(config.executors.lody.models)[provider]?.find(
        (candidate) => candidate.id === fallback,
      );
      if (effort && option && !(option.efforts as readonly string[]).includes(effort))
        effort = null;
    }
    return { machineKey: key, machine, provider, agent, model, effort, note };
  }
  return { reason: reasons[0] ?? "没有可用的执行机", offline: !anyOnline };
}

export class HarnessScheduler {
  private timer: ReturnType<typeof setInterval> | null = null;
  private running: Promise<void> | null = null;
  readonly queue: QueueWatch;
  private readonly reconciler: HarnessReconciler;

  constructor(private readonly work: HarnessWork) {
    this.queue = new QueueWatch(work);
    this.reconciler = new HarnessReconciler(work);
  }

  start() {
    if (this.timer) return;
    this.timer = setInterval(() => void this.tick(), TICK_MS);
    this.timer.unref();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** Overlapping ticks share one run. */
  tick(): Promise<void> {
    this.running ??= this.runTick().finally(() => {
      this.running = null;
    });
    return this.running;
  }

  private async runTick() {
    const { service } = this.work;
    if (!service.active || !service.telegram) return;
    for (const step of [
      () => this.recoverStale(),
      () => this.startQueued(),
      () => pollJobs(this.work),
      () => warnQuota(this.work),
      () => service.prFlow.resyncDue(),
      () => service.releases.poll(),
      () => this.reconciler.run(),
    ]) {
      try {
        await step();
      } catch (error) {
        service.logger.error(`Dev Harness scheduler step failed: ${errorText(error)}`);
      }
    }
  }

  /** A crash between creating the session and persisting its id must not start a second one. */
  private async recoverStale() {
    const { service } = this.work;
    const now = service.now();
    for (const job of await service.store.listJobs([JOB_STATES.starting])) {
      if (job.leaseUntil && job.leaseUntil > now) continue;
      await this.work.withRequest(job.requestId, () =>
        this.markLost(job.id, job.requestId, "服务可能在创建时重启"),
      );
    }
    // A request left in `starting` without a live job (insertJob failed, or a crash between
    // steps) is repaired under its lock, where startRequest would otherwise be running.
    for (const stuck of await service.store.listRequestsByState([S.starting])) {
      await this.work.withRequest(stuck.id, async () => {
        const request = await service.store.getRequest(stuck.id);
        if (request?.state !== S.starting) return;
        const job = await service.store.latestJob(request.id);
        if (job?.state === JOB_STATES.running) {
          await service.store.transitionRequest(request.id, [S.starting], S.running);
        } else if (job?.state !== JOB_STATES.starting) {
          await service.store.transitionRequest(request.id, [S.starting], S.needsAttention, {
            stateReason: "启动中断，未创建会话记录，可以重新排队",
          });
        } else return;
        const fresh = await service.store.getRequest(request.id);
        if (fresh) await this.work.refreshCard(fresh);
      });
    }
  }

  /** Same outcome for a stale lease and an unknown create result: the owner decides. */
  private async markLost(jobId: string, requestId: string, detail: string) {
    const { service } = this.work;
    await service.store.updateJob(jobId, {
      state: JOB_STATES.lost,
      endedAt: service.now(),
      leaseUntil: null,
      error: `会话创建结果未知：${detail}`,
    });
    const moved = await service.store.transitionRequest(requestId, [S.starting], S.needsAttention, {
      stateReason: `会话创建结果未知（${detail}），请先在 Lody 中确认，再重新排队或取消`,
    });
    const request = await service.store.getRequest(requestId);
    if (moved && request) await this.work.refreshCard(request);
  }

  private async load(): Promise<Load> {
    const { service } = this.work;
    const perMachine = new Map<string, number>();
    const perProject = new Map<string, number>();
    const holders = await service.store.listRequestsByState(AREA_HOLDING_STATES);
    const active = new Set(
      holders
        .filter((r) => (ACTIVE_STATES as readonly string[]).includes(r.state))
        .map((r) => r.id),
    );
    for (const job of await service.store.listJobs([JOB_STATES.starting, JOB_STATES.running])) {
      if (!active.has(job.requestId)) continue;
      increment(perMachine, job.machineKey);
    }
    for (const request of holders) {
      if (active.has(request.id)) increment(perProject, request.projectKey);
    }
    const timeZone = service.globalView().config.telegram.notify.timezone;
    const today = await service.store.countJobsSince(startOfDay(service.now(), timeZone));
    return { perMachine, perProject, holders, today };
  }

  private waitReason(config: ProjectEffectiveConfig, request: HarnessRequestRecord, load: Load) {
    const { concurrency, quota } = config.guardrails;
    if (quota.dailySessionCap !== null && load.today >= quota.dailySessionCap) {
      return `今日会话数已达上限 ${quota.dailySessionCap}`;
    }
    if ((load.perProject.get(request.projectKey) ?? 0) >= concurrency.perProject) {
      return `项目并发已满（${concurrency.perProject}）`;
    }
    const areas = requestAreas(request.areas);
    const writers = load.holders.filter(
      (other) =>
        other.id !== request.id &&
        other.projectKey === request.projectKey &&
        areasConflict(areas, requestAreas(other.areas)),
    );
    if (writers.length >= concurrency.sameAreaWriters) {
      const first = writers[0]!;
      return `等待同区域的 ${first.issueNumber ? `#${first.issueNumber}` : "请求"} 完成`;
    }
    return null;
  }

  private async startQueued() {
    const { service } = this.work;
    const queued = await service.store.listRequestsByState([S.queued]);
    this.queue.forget(queued);
    if (queued.length === 0) return;
    const listed = await service.lody().listMachines();
    const agents = listed.ok ? await service.lody().listAgentConfigs() : null;
    const load = await this.load();
    for (const request of queued) {
      const config = this.work.config(request.projectKey);
      if (!config) continue;
      const limit = this.waitReason(config, request, load);
      let wait: WaitReason | null = limit ? { reason: limit, offline: false } : null;
      let choice: MachineChoice | null = null;
      if (!wait) {
        if (!listed.ok) wait = { reason: `执行层不可用：${listed.message}`, offline: true };
        else {
          const picked = chooseMachine(
            config,
            listed.value,
            load.perMachine,
            agents?.ok ? agents.value : null,
          );
          if ("reason" in picked) wait = picked;
          else choice = picked;
        }
      }
      if (!choice) {
        await this.hold(request, config, wait ?? { reason: "等待中", offline: false });
        continue;
      }
      if (await this.startRequest(request, config, choice)) {
        increment(load.perMachine, choice.machineKey);
        increment(load.perProject, request.projectKey);
        load.holders.push({ ...request, state: S.starting });
        load.today++;
      }
    }
  }

  /** Keeps the wait reason and queued-for time on the card current, then escalates if due. */
  private async hold(
    request: HarnessRequestRecord,
    config: ProjectEffectiveConfig,
    wait: WaitReason,
  ) {
    const since = await this.queue.since(request);
    const ageChanged = this.queue.ageChanged(request, since);
    if (request.stateReason !== wait.reason || ageChanged) {
      await this.work.withRequest(request.id, async () => {
        const moved = await this.work.service.store.transitionRequest(
          request.id,
          [S.queued],
          S.queued,
          { stateReason: wait.reason },
        );
        const fresh = moved ? await this.work.service.store.getRequest(request.id) : null;
        if (fresh) await this.work.refreshCard(fresh);
      });
    }
    if (wait.offline) await this.queue.escalate(request, config, since, wait.reason);
  }

  private startRequest(
    request: HarnessRequestRecord,
    config: ProjectEffectiveConfig,
    choice: MachineChoice,
  ): Promise<boolean> {
    const { service } = this.work;
    return this.work.withRequest(request.id, async () => {
      const now = service.now();
      if (
        !(await service.store.transitionRequest(request.id, [S.queued], S.starting, {
          stateReason: choice.note,
        }))
      ) {
        return false;
      }
      const previous = await service.store.latestJob(request.id);
      const attempt = (previous?.attempt ?? 0) + 1;
      const retry = async (message: string) => {
        const giveUp = attempt >= MAX_START_ATTEMPTS;
        await service.store.transitionRequest(
          request.id,
          [S.starting],
          giveUp ? S.needsAttention : S.queued,
          {
            stateReason: giveUp
              ? `会话创建连续失败 ${attempt} 次：${message}`
              : `会话创建失败，稍后重试：${message}`,
          },
        );
        await service.recordEvent({
          type: "session.create_failed",
          projectKey: request.projectKey,
          requestId: request.id,
          payload: { attempt, message },
        });
      };
      let prompt: string;
      let job: HarnessJobRecord;
      try {
        const fresh = (await service.store.getRequest(request.id))!;
        prompt = await this.work.prompt(fresh, fresh.type === "task" ? "task" : "bug", {
          ownerText: fresh.ownerText,
          lead: {
            agent: choice.agent,
            model: choice.model,
            effort: choice.effort,
            vendor: choice.provider,
          },
        });
        job = await service.store.insertJob({
          requestId: request.id,
          attempt,
          executor: "lody",
          state: JOB_STATES.starting,
          machineKey: choice.machineKey,
          lodyMachine: choice.machine.name,
          provider: choice.provider,
          role: "worker",
          agent: choice.agent,
          model: choice.model,
          leaseUntil: new Date(now.getTime() + START_LEASE_MS),
          quota: quotaSnapshot(choice.machine, choice.provider, choice.model),
        });
        await this.work.refreshCard((await service.store.getRequest(request.id))!);
      } catch (error) {
        // Nothing reached Lody yet, so a retry cannot duplicate a session.
        await retry(errorText(error));
        const after = await service.store.getRequest(request.id);
        if (after) await this.work.refreshCard(after);
        return false;
      }
      const result = await service
        .lody()
        .createSession({
          machine: choice.machine.id || choice.machine.name,
          localProject: config.project.localProject ?? config.project.repo.split("/")[1]!,
          worktree: config.executors.lody.worktree,
          agent: choice.agent,
          model: choice.model,
          configOptions: [effortConfigOption(choice.provider, choice.effort)].filter(
            (option): option is string => option !== null,
          ),
          title: sessionTitle(config.project.key, request),
          prompt,
          workspace:
            config.executors.lody.workspace === "auto" ? null : config.executors.lody.workspace,
        })
        .catch((error) => ({
          ok: false as const,
          reason: "unknown" as const,
          message: errorText(error),
        }));
      if (!result.ok && result.reason === "unknown") {
        await this.markLost(job.id, request.id, result.message);
        return false;
      }
      if (!result.ok) {
        await service.store.updateJob(job.id, {
          state: JOB_STATES.failed,
          endedAt: service.now(),
          leaseUntil: null,
          error: result.message,
        });
        await retry(result.message);
      } else {
        const started = service.now();
        await service.store.updateJob(job.id, {
          state: JOB_STATES.running,
          sessionId: result.value.sessionId,
          leaseUntil: null,
          startedAt: started,
          lastActivityAt: started,
          nextPollAt: new Date(started.getTime() + durationMs(config.executors.lody.poll.active)),
        });
        await service.store.transitionRequest(request.id, [S.starting], S.running);
        await service.recordEvent({
          type: "session.created",
          projectKey: request.projectKey,
          requestId: request.id,
          payload: { attempt, machine: choice.machine.name, model: choice.model },
        });
      }
      const after = await service.store.getRequest(request.id);
      if (after) await this.work.refreshCard(after);
      return result.ok;
    });
  }
}
