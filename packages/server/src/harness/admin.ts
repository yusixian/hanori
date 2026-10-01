import type {
  HarnessAdminExecution,
  HarnessAdminMachine,
  HarnessAdminOverview,
  HarnessAdminPolicyPatch,
  HarnessAdminPolicySummary,
  HarnessAdminPreview,
  HarnessAdminProject,
  HarnessAdminRepoList,
} from "@cos-tool-bot/shared";
import { z } from "zod";
import {
  type ExecutionScope,
  HarnessAdminError,
  checkExecution,
  executionView,
  parseInput,
  toAdminExecution,
  withTimeout,
} from "./admin-execution.js";
import {
  type AgentConfigInfo,
  type ExecutionSetting,
  resolveWorkerExecution,
} from "./config/execution.js";
import { formatIssues } from "./config/layers.js";
import {
  type PanelBinding,
  compactPatch,
  executionSettingSchema,
  panelBindingSchema,
  parseExecutionSetting,
  policyPatchSchema,
} from "./config/panel.js";
import { GLOBAL_SCOPE } from "./config/resolve.js";
import { PROJECT_KEY_PATTERN, REPO_PATTERN } from "./config/schema.js";
import type { AccessibleRepository } from "./github.js";
import { findMachine } from "./lody.js";
import { projectPolicySummary, suggestKey, summarizeCandidate } from "./admin-policy.js";
import { fetchRepoPolicy } from "./policy-refresh.js";
import { topicLink } from "./render.js";
import type { HarnessService } from "./service.js";
import { ACTIVE_STATES, WAITING_STATES } from "./states.js";

export { HarnessAdminError } from "./admin-execution.js";

/** `actorId` is a Telegram user id (Mini App); panel users are recorded by their panel id. */
export interface HarnessAdminActor {
  via: "panel" | "mini-app";
  actorId: number | null;
  panelUserId?: string;
}

export interface HarnessAdminOptions {
  machineTimeoutMs?: number;
  repoCacheMs?: number;
  now?: () => number;
}

const keySchema = z
  .string()
  .regex(PROJECT_KEY_PATTERN, "项目名只能包含小写字母、数字、- 和 _，最长 32 位")
  .refine((key) => key !== GLOBAL_SCOPE, "global 是保留名");
const repoSchema = z.string().trim().regex(REPO_PATTERN, "应为 owner/name");
const machinesSchema = z.array(z.string().min(1).max(64)).max(20);
const localProjectSchema = z.string().trim().max(200).nullable().optional();

const previewInputSchema = z.strictObject({ repo: repoSchema });
const projectInputSchema = z.strictObject({
  key: keySchema,
  repo: repoSchema,
  machines: machinesSchema,
  localProject: localProjectSchema,
  policyPatch: policyPatchSchema.nullable().optional(),
  execution: executionSettingSchema.nullable().optional(),
});
const projectPatchSchema = z.strictObject({
  machines: machinesSchema.optional(),
  localProject: localProjectSchema,
  policyPatch: policyPatchSchema.nullable().optional(),
  execution: executionSettingSchema.nullable().optional(),
});

const NO_EXECUTION: HarnessAdminExecution = { agentConfig: null, model: null, effort: null };

/** Everything the web panel and the Mini App do to Dev Harness projects goes through here. */
export class HarnessAdmin {
  private repoCache: { at: number; repos: AccessibleRepository[] } | null = null;
  private readonly now: () => number;

  constructor(
    private readonly service: HarnessService | null,
    private readonly options: HarnessAdminOptions = {},
  ) {
    this.now = options.now ?? Date.now;
  }

  get botId(): string | null {
    return this.service?.botId ?? null;
  }

  isOwner(telegramUserId: number): boolean {
    return Boolean(this.service?.active && this.service.port.isOwner(telegramUserId));
  }

  private requireService(): HarnessService {
    if (!this.service?.active) {
      throw new HarnessAdminError("not_enabled", "Dev Harness 未启用或 harness.yaml 未加载");
    }
    return this.service;
  }

  private get lodyTimeoutMs() {
    return this.options.machineTimeoutMs ?? 15_000;
  }

  async overview(): Promise<HarnessAdminOverview> {
    const service = this.service;
    const empty = {
      chatId: null,
      projects: [],
      machines: [],
      execution: { effective: NO_EXECUTION, panel: null, agents: null },
    };
    if (!service) return { enabled: false, configError: null, ...empty };
    if (!service.active) {
      const issues = service.lastReloadError?.issues ?? [];
      const configError = issues.length > 0 ? formatIssues(issues, 10) : "harness.yaml 未加载";
      return { enabled: true, configError, ...empty };
    }
    const [machines, agentResult, runtime] = await Promise.all([
      this.machines(),
      withTimeout(service.lody().listAgentConfigs(), this.lodyTimeoutMs),
      this.runtimeStatus(),
    ]);
    const agents = agentResult?.ok ? agentResult.value : null;
    const projects = service.projectKeys().flatMap((key) => this.project(key, agents) ?? []);
    const warnings: string[] = [];
    for (const [key, reason] of service.shadowedPanelProjects) {
      warnings.push(`面板项目 ${key} 未生效：${reason}`);
      if (!service.projectKeys().includes(key)) {
        const shadowed = this.shadowedProject(key, reason, agents);
        if (shadowed) projects.push(shadowed);
      }
    }
    return {
      enabled: true,
      configError: null,
      chatId: service.file.telegram.chatId,
      projects,
      machines,
      execution: {
        ...executionView(service, agents),
        runtime,
        agentError: agentResult?.ok
          ? null
          : (agentResult?.message ?? "读取 Lody 执行配置超时，请刷新重试。"),
      },
      ...(warnings.length > 0 ? { warnings } : {}),
    };
  }

  private async runtimeStatus() {
    const runtime = this.requireService().lodyRuntime();
    return runtime ? withTimeout(runtime.status(), this.lodyTimeoutMs) : null;
  }

  async refreshExecution() {
    const service = this.requireService();
    service.lody().clearCatalogCache();
    const result = await withTimeout(service.lody().listAgentConfigs(), this.lodyTimeoutMs);
    if (!result?.ok)
      throw new HarnessAdminError(
        "lody_unavailable",
        result?.message ?? "读取 Lody 执行配置超时，请稍后重试。",
      );
    return {
      execution: {
        ...executionView(service, result.value),
        agentError: null,
        runtime: await this.runtimeStatus(),
      },
    };
  }

  async updateRuntime(actor: HarnessAdminActor) {
    const service = this.requireService();
    const runtime = service.lodyRuntime();
    if (!runtime)
      throw new HarnessAdminError(
        "lody_unavailable",
        "本地 CLI 请在所在机器上更新；页面更新需要 lody-bridge。",
      );
    if (service.lodyUpdating) throw new HarnessAdminError("conflict", "Lody CLI 正在更新。");
    service.lodyUpdating = true;
    try {
      await service.work.scheduler.tick();
      if ((await service.store.listRequestsByState(ACTIVE_STATES)).length > 0) {
        throw new HarnessAdminError("conflict", "Harness 仍有运行中的任务，请结束后再更新 CLI。");
      }
      const result = await runtime.update();
      service.lody().clearCatalogCache();
      await service.recordEvent({
        type: "runtime.updated",
        actorId: actor.actorId,
        payload: { via: actor.via, version: result.version, updated: result.updated },
      });
      return { runtime: result };
    } catch (cause) {
      if (cause instanceof HarnessAdminError) throw cause;
      throw new HarnessAdminError(
        (cause as { code?: string }).code === "conflict" ? "conflict" : "lody_unavailable",
        cause instanceof Error ? cause.message : "Lody CLI 更新失败。请刷新查看当前版本后再重试。",
      );
    } finally {
      // A lost HTTP response can leave the bridge updating; discard pre-update online results.
      service.lody().clearCatalogCache();
      service.lodyUpdating = false;
    }
  }

  private async machines(): Promise<HarnessAdminMachine[]> {
    const service = this.requireService();
    const result = await withTimeout(service.lody().listMachines(), this.lodyTimeoutMs);
    const listed = result?.ok ? result.value : null;
    return Object.entries(service.file.machines).map(([key, machine]) => ({
      key,
      lodyName: machine.lody,
      online: listed ? (findMachine(listed, machine.lody)?.online ?? false) : null,
    }));
  }

  private project(key: string, agents: AgentConfigInfo[] | null): HarnessAdminProject | null {
    const service = this.requireService();
    const view = service.projectView(key);
    const policy = projectPolicySummary(this.requireService(), key);
    if (!view || !policy) return null;
    const record = service.projectRecord(key);
    const panel = service.isPanelProject(key);
    const threadId = service.projectThread(key) ?? null;
    const { project } = view.config;
    return {
      key,
      repo: project.repo,
      source: panel ? "panel" : "yaml",
      editable: panel,
      machines: [...project.machines],
      localProject: project.localProject ?? project.repo.split("/")[1]!,
      topic: {
        threadId,
        url: threadId ? topicLink(service.file.telegram.chatId, threadId) : null,
        error: threadId ? null : (record?.topicError ?? null),
      },
      policy,
      policyPatch: panel ? ((record?.policyPatch as HarnessAdminPolicyPatch | null) ?? null) : null,
      execution: {
        effective: toAdminExecution(resolveWorkerExecution(view.config, agents)),
        panel: parseExecutionSetting(record?.execution),
      },
    };
  }

  /** Listed so the owner can fix or delete it; a key clash with YAML only shows as a warning. */
  private shadowedProject(
    key: string,
    reason: string,
    agents: AgentConfigInfo[] | null,
  ): HarnessAdminProject | null {
    const service = this.requireService();
    const record = service.projectRecord(key);
    const binding = panelBindingSchema.safeParse(record?.binding);
    if (!record || !binding.success) return null;
    const preview = summarizeCandidate(service, binding.data.repo, null, null, reason);
    return {
      key,
      repo: binding.data.repo,
      source: "panel",
      editable: true,
      machines: binding.data.machines,
      localProject: binding.data.localProject ?? binding.data.repo.split("/")[1]!,
      topic: { threadId: null, url: null, error: reason },
      policy: preview,
      policyPatch: (record.policyPatch as HarnessAdminPolicyPatch | null) ?? null,
      execution: {
        effective: toAdminExecution(resolveWorkerExecution(service.globalView().config, agents)),
        panel: parseExecutionSetting(record.execution),
      },
    };
  }

  private async accessibleRepos(refresh = false): Promise<AccessibleRepository[]> {
    const github = this.requireService().github;
    if (!github?.available) {
      throw new HarnessAdminError("github_unavailable", "GitHub App 未配置");
    }
    const fresh =
      this.repoCache && this.now() - this.repoCache.at < (this.options.repoCacheMs ?? 60_000);
    if (!refresh && fresh) return this.repoCache!.repos;
    try {
      const repos = await github.listAccessibleRepositories();
      this.repoCache = { at: this.now(), repos };
      return repos;
    } catch (error) {
      throw new HarnessAdminError(
        "github_unavailable",
        `无法列出 GitHub App 可访问的仓库：${(error as Error).message.slice(0, 200)}`,
      );
    }
  }

  /** Returns the canonical `owner/name`; retries once uncached so a fresh grant is picked up. */
  private async resolveRepo(repo: string): Promise<string> {
    if (!this.requireService().github?.available) return repo;
    const wanted = repo.toLowerCase();
    for (const refresh of [false, true]) {
      const match = (await this.accessibleRepos(refresh)).find(
        (candidate) => candidate.fullName.toLowerCase() === wanted,
      );
      if (match) return match.fullName;
    }
    throw new HarnessAdminError("invalid", `GitHub App 无权访问 ${repo}，请先在 GitHub 上授权`, [
      { path: "repo", message: "GitHub App 无权访问该仓库" },
    ]);
  }

  private trackedRepos(): Set<string> {
    const service = this.requireService();
    const repos = new Set(Object.values(service.file.projects).map((p) => p.repo.toLowerCase()));
    for (const record of service.allProjectRecords()) {
      const binding = panelBindingSchema.safeParse(record.binding);
      if (binding.success) repos.add(binding.data.repo.toLowerCase());
    }
    return repos;
  }

  private keyTaken(key: string): boolean {
    const service = this.requireService();
    return (
      Object.hasOwn(service.file.projects, key) || Boolean(service.projectRecord(key)?.binding)
    );
  }

  async repos(): Promise<HarnessAdminRepoList> {
    const service = this.requireService();
    const tracked = this.trackedRepos();
    const repos = await this.accessibleRepos(true);
    return {
      repos: repos
        .map((repo) => ({
          fullName: repo.fullName,
          private: repo.private,
          defaultBranch: repo.defaultBranch,
          tracked: tracked.has(repo.fullName.toLowerCase()),
        }))
        .sort((a, b) => a.fullName.localeCompare(b.fullName)),
      installUrl: service.github?.installUrl ?? null,
    };
  }

  async preview(body: unknown): Promise<HarnessAdminPreview> {
    const service = this.requireService();
    const repo = await this.resolveRepo(parseInput(previewInputSchema, body).repo);
    const name = repo.split("/")[1]!;
    const suggestedKey = suggestKey(name, (key) => this.keyTaken(key));
    let policy: HarnessAdminPolicySummary;
    if (!service.github?.available) {
      policy = summarizeCandidate(service, repo, null, null, "GitHub App 未配置，使用默认值");
    } else {
      const fetched = await fetchRepoPolicy({
        github: service.github,
        repo,
        now: service.now(),
        validate: () => [],
      });
      policy = summarizeCandidate(
        service,
        repo,
        fetched.policy ?? null,
        fetched.inferredPolicy ?? null,
        fetched.policyError ?? null,
      );
    }
    return { repo, suggestedKey, suggestedLocalProject: name, policy };
  }

  private validateMachines(machines: readonly string[]): string[] {
    const known = this.requireService().file.machines;
    const unique = [...new Set(machines)];
    const unknown = unique.filter((key) => !Object.hasOwn(known, key));
    if (unknown.length > 0) {
      throw new HarnessAdminError("invalid", `harness.yaml 中没有执行机：${unknown.join("、")}`, [
        { path: "machines", message: `未知执行机：${unknown.join("、")}` },
      ]);
    }
    return unique;
  }

  private async event(type: string, key: string, actor: HarnessAdminActor, payload: object) {
    await this.requireService().recordEvent({
      type,
      projectKey: key,
      actorId: actor.actorId,
      payload: { ...payload, via: actor.via, panelUserId: actor.panelUserId ?? null },
    });
  }

  private checkExecution(
    setting: ExecutionSetting | null,
    scope: ExecutionScope,
  ): Promise<AgentConfigInfo[] | null> {
    return checkExecution(this.requireService(), setting, scope, this.lodyTimeoutMs);
  }

  async setExecution(body: unknown, actor: HarnessAdminActor) {
    const service = this.requireService();
    const setting = parseExecutionSetting(parseInput(executionSettingSchema, body, "execution."));
    const agents = await this.checkExecution(setting, "global");
    await service.setPanelExecution(setting, actor.actorId);
    await service.recordEvent({
      type: "execution.updated",
      actorId: actor.actorId,
      payload: { ...setting, via: actor.via, panelUserId: actor.panelUserId ?? null },
    });
    return { execution: executionView(service, agents) };
  }

  async createProject(body: unknown, actor: HarnessAdminActor): Promise<HarnessAdminProject> {
    const service = this.requireService();
    const input = parseInput(projectInputSchema, body);
    if (this.keyTaken(input.key)) {
      throw new HarnessAdminError("conflict", `项目名 ${input.key} 已存在`);
    }
    const repo = await this.resolveRepo(input.repo);
    if (this.trackedRepos().has(repo.toLowerCase())) {
      throw new HarnessAdminError("conflict", `${repo} 已绑定到其他项目`);
    }
    const binding: PanelBinding = {
      repo,
      machines: this.validateMachines(input.machines),
      ...(input.localProject ? { localProject: input.localProject } : {}),
    };
    const execution = parseExecutionSetting(input.execution);
    const agents = await this.checkExecution(execution, "new-project");
    await service.updatePanelProject(input.key, repo, {
      binding,
      policyPatch: compactPatch(input.policyPatch),
      execution: execution ? { ...execution } : null,
      policy: null,
      policySha: null,
      policyError: null,
      inferredPolicy: null,
      kind: null,
      defaultBranch: null,
    });
    await this.event("project.created", input.key, actor, { repo, machines: binding.machines });
    return this.project(input.key, agents) ?? this.shadowedProject(input.key, "未生效", agents)!;
  }

  private panelBinding(key: string): PanelBinding | null {
    const binding = panelBindingSchema.safeParse(this.requireService().projectRecord(key)?.binding);
    return binding.success ? binding.data : null;
  }

  private editableBinding(key: string): PanelBinding {
    const binding = this.panelBinding(key);
    if (binding) return binding;
    if (Object.hasOwn(this.requireService().file.projects, key)) {
      throw new HarnessAdminError("read_only", `${key} 来自 harness.yaml，只能在文件中修改`);
    }
    throw new HarnessAdminError("not_found", `没有面板项目 ${key}`);
  }

  /** harness.yaml projects accept only `execution`, which is stored apart from the file. */
  async updateProject(
    key: string,
    body: unknown,
    actor: HarnessAdminActor,
  ): Promise<HarnessAdminProject> {
    const service = this.requireService();
    const patch = parseInput(projectPatchSchema, body);
    const current = this.panelBinding(key);
    const yamlOnly =
      !current && Object.hasOwn(service.file.projects, key) && patch.execution !== undefined
        ? Object.entries(patch).every(
            ([field, value]) => field === "execution" || value === undefined,
          )
        : false;
    const binding = yamlOnly ? null : this.editableBinding(key);
    const execution =
      patch.execution === undefined
        ? parseExecutionSetting(service.projectRecord(key)?.execution)
        : parseExecutionSetting(patch.execution);
    const agents = await this.checkExecution(patch.execution === undefined ? null : execution, {
      projectKey: key,
    });
    const executionPatch = { execution: execution ? { ...execution } : null };
    if (!binding) {
      await service.updatePanelProject(key, service.file.projects[key]!.repo, executionPatch);
    } else {
      const next: PanelBinding = {
        repo: binding.repo,
        machines:
          patch.machines === undefined ? binding.machines : this.validateMachines(patch.machines),
      };
      const localProject =
        patch.localProject === undefined ? binding.localProject : patch.localProject || undefined;
      if (localProject) next.localProject = localProject;
      const policyPatch =
        patch.policyPatch === undefined
          ? (service.projectRecord(key)?.policyPatch ?? null)
          : compactPatch(patch.policyPatch);
      await service.updatePanelProject(key, binding.repo, {
        binding: next,
        policyPatch,
        ...executionPatch,
      });
    }
    await this.event("project.updated", key, actor, {
      fields: Object.keys(patch).filter(
        (field) => patch[field as keyof typeof patch] !== undefined,
      ),
    });
    const shadow = service.shadowedPanelProjects.get(key);
    return (
      shadow && !Object.hasOwn(service.file.projects, key)
        ? this.shadowedProject(key, shadow, agents)
        : this.project(key, agents)
    )!;
  }

  async deleteProject(key: string, actor: HarnessAdminActor): Promise<void> {
    const service = this.requireService();
    const current = this.editableBinding(key);
    const busy = await service.store.countRequests(key, [...WAITING_STATES, ...ACTIVE_STATES]);
    if (busy > 0 && service.isPanelProject(key)) {
      throw new HarnessAdminError("conflict", `${key} 还有 ${busy} 个排队或进行中的任务`);
    }
    // A key shared with a harness.yaml project keeps that project's execution override.
    const keepsExecution =
      Object.hasOwn(service.file.projects, key) && !service.isPanelProject(key);
    await service.updatePanelProject(key, current.repo, {
      binding: null,
      policyPatch: null,
      ...(keepsExecution ? {} : { execution: null }),
    });
    await this.event("project.deleted", key, actor, { repo: current.repo });
  }
}
