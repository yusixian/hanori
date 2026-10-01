import type {
  HarnessAdminErrorCode,
  HarnessAdminExecution,
  HarnessAdminExecutionView,
} from "@cos-tool-bot/shared";
import type { z } from "zod";
import {
  type AgentConfigInfo,
  type ExecutionSetting,
  type WorkerExecution,
  executionLayerData,
  findAgentConfig,
  modelsForAgent,
  modelCatalog,
  resolveWorkerExecution,
} from "./config/execution.js";
import { type ConfigIssue, deepMerge, formatIssues } from "./config/layers.js";
import { resolveGlobalConfig, resolveProjectConfig } from "./config/resolve.js";
import type { HarnessService } from "./service.js";

export class HarnessAdminError extends Error {
  constructor(
    readonly code: HarnessAdminErrorCode,
    message: string,
    readonly issues?: ConfigIssue[],
  ) {
    super(message);
    this.name = "HarnessAdminError";
  }
}

export function parseInput<S extends z.ZodType>(
  schema: S,
  value: unknown,
  prefix = "",
): z.output<S> {
  const parsed = schema.safeParse(value);
  if (parsed.success) return parsed.data;
  const issues = parsed.error.issues.map((issue) => ({
    path: `${prefix}${issue.path.map(String).join(".")}` || "(根)",
    message:
      issue.code === "unrecognized_keys" ? `未知字段：${issue.keys.join("、")}` : issue.message,
  }));
  throw new HarnessAdminError("invalid", issues[0]?.message ?? "请求无效", issues);
}

/** Resolves to null when the call fails or outlives `timeoutMs`. */
export function withTimeout<T>(work: Promise<T>, timeoutMs: number): Promise<T | null> {
  const timeout = new Promise<null>((resolve) => {
    setTimeout(() => resolve(null), timeoutMs).unref?.();
  });
  return Promise.race([work.catch(() => null), timeout]);
}

export async function listAgents(
  service: HarnessService,
  timeoutMs: number,
): Promise<AgentConfigInfo[] | null> {
  const result = await withTimeout(service.lody().listAgentConfigs(), timeoutMs);
  return result?.ok ? result.value : null;
}

export function toAdminExecution(execution: WorkerExecution): HarnessAdminExecution {
  return { agentConfig: execution.agent, model: execution.model, effort: execution.effort };
}

type ExecutionConfig = Parameters<typeof resolveWorkerExecution>[0];

export function executionView(
  service: HarnessService,
  agents: readonly AgentConfigInfo[] | null,
): HarnessAdminExecutionView {
  const config = service.globalView().config;
  return {
    effective: toAdminExecution(resolveWorkerExecution(config, agents)),
    panel: service.panelExecutionSetting,
    agents:
      agents?.map((agent) => ({
        id: agent.id,
        name: agent.name,
        agentType: agent.agentType,
        models: modelsForAgent(agent, config.executors.lody.models),
      })) ?? null,
  };
}

/**
 * Checks the setting against what it resolves to: a listed agent config (when Lody answers) and,
 * for catalog models, an effort that model supports. Custom model ids are allowed.
 */
export function validateExecution(
  candidate: ExecutionConfig,
  setting: ExecutionSetting,
  agents: readonly AgentConfigInfo[] | null,
  path: string,
): void {
  if (setting.agentConfig && agents && !findAgentConfig(agents, setting.agentConfig)) {
    throw new HarnessAdminError("invalid", `Lody 中没有执行配置 ${setting.agentConfig}`, [
      { path: `${path}agentConfig`, message: "未找到该执行配置" },
    ]);
  }
  const resolved = resolveWorkerExecution(candidate, agents);
  if (!resolved.effort || resolved.effort === "default") return;
  const selectedAgent = findAgentConfig(agents, resolved.agent);
  const models = selectedAgent
    ? modelsForAgent(selectedAgent, candidate.executors.lody.models)
    : (modelCatalog(candidate.executors.lody.models)[resolved.vendor] ?? []);
  const option = models.find((model) => model.id === (resolved.model ?? "default"));
  if (option && !(option.efforts as string[]).includes(resolved.effort)) {
    throw new HarnessAdminError("invalid", `${option.name} 不支持推理强度 ${resolved.effort}`, [
      { path: `${path}effort`, message: `可选：${option.efforts.join("、")}` },
    ]);
  }
}

export type ExecutionScope = { projectKey: string } | "global" | "new-project";

/**
 * Resolves `setting` in its scope and rejects agents or efforts Lody would not accept. Issue
 * paths start with `execution.` so the GUI can place them.
 */
export async function checkExecution(
  service: HarnessService,
  setting: ExecutionSetting | null,
  scope: ExecutionScope,
  timeoutMs: number,
): Promise<AgentConfigInfo[] | null> {
  const agents = await listAgents(service, timeoutMs);
  if (!setting) return agents;
  const layer = executionLayerData(setting);
  const globalLayer = executionLayerData(service.panelExecutionSetting);
  let resolved;
  if (typeof scope === "object") {
    const input = service.projectInput(scope.projectKey);
    resolved = resolveProjectConfig({ ...input, panel: { ...input.panel!, execution: layer } });
  } else {
    const panel = scope === "global" ? layer : deepMerge(globalLayer ?? {}, layer ?? {});
    resolved = resolveGlobalConfig(
      service.loadedConfig!.raw,
      service.overrideList,
      service.now(),
      panel,
    );
  }
  if (!resolved.ok) {
    throw new HarnessAdminError("invalid", formatIssues(resolved.issues, 3), resolved.issues);
  }
  validateExecution(resolved.value, setting, agents, "execution.");
  return agents;
}
