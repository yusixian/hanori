import type {
  HarnessAdminAgentOption,
  HarnessAdminExecution,
  HarnessAdminModelOption,
} from "@cos-tool-bot/shared";

export const DEFAULT_EXECUTION: HarnessAdminExecution = {
  agentConfig: null,
  model: null,
  effort: null,
};

export function findAgent(
  agents: readonly HarnessAdminAgentOption[] | null,
  agentConfig: string | null,
): HarnessAdminAgentOption | undefined {
  if (!agents || !agentConfig) return undefined;
  return (
    agents.find((agent) => agent.id === agentConfig) ??
    agents.find((agent) => agent.name === agentConfig)
  );
}

export function findModel(
  agent: HarnessAdminAgentOption | undefined,
  model: string | null,
): HarnessAdminModelOption | undefined {
  return model ? agent?.models.find((candidate) => candidate.id === model) : undefined;
}

export function preferredEffort(efforts: readonly string[]): string | null {
  return efforts.includes("high") ? "high" : (efforts[0] ?? "default");
}

/** The agent whose catalog applies: the draft's choice, else the effective one. */
export function activeAgent(
  agents: readonly HarnessAdminAgentOption[] | null,
  draft: HarnessAdminExecution,
  effective: HarnessAdminExecution,
): HarnessAdminAgentOption | undefined {
  return findAgent(agents, draft.agentConfig ?? effective.agentConfig);
}

/** Keeps the effort valid for the newly chosen model, preferring `high`. */
export function withModel(
  draft: HarnessAdminExecution,
  model: string | null,
  agent: HarnessAdminAgentOption | undefined,
  effective: HarnessAdminExecution,
): HarnessAdminExecution {
  const next = { ...draft, model };
  const efforts = findModel(agent, model)?.efforts;
  if (!efforts) return next;
  if (efforts.length === 0) return { ...next, effort: "default" };
  const currentEffort = draft.effort ?? effective.effort;
  return currentEffort && efforts.includes(currentEffort)
    ? next
    : { ...next, effort: preferredEffort(efforts) };
}

/** Switching agents keeps the model only when the new agent offers it. */
export function withAgent(
  draft: HarnessAdminExecution,
  agentConfig: string | null,
  agents: readonly HarnessAdminAgentOption[] | null,
  effective: HarnessAdminExecution,
): HarnessAdminExecution {
  const next = { ...draft, agentConfig };
  const agent = findAgent(agents, agentConfig ?? effective.agentConfig);
  if (!agent) return next;
  const model = draft.model ?? effective.model;
  if (model && agent.models.some((candidate) => candidate.id === model)) {
    return withModel(next, draft.model, agent, effective);
  }
  const first = agent.models[0];
  return first
    ? { ...next, model: first.id, effort: preferredEffort(first.efforts) }
    : { ...next, model: null, effort: null };
}

export function normalizeExecution(execution: HarnessAdminExecution): HarnessAdminExecution {
  return {
    agentConfig: execution.agentConfig?.trim() || null,
    model: execution.model?.trim() || null,
    effort: execution.effort?.trim() || null,
  };
}

export function sameExecution(
  left: HarnessAdminExecution | null,
  right: HarnessAdminExecution | null,
): boolean {
  if (!left || !right) return left === right;
  const a = normalizeExecution(left);
  const b = normalizeExecution(right);
  return a.agentConfig === b.agentConfig && a.model === b.model && a.effort === b.effort;
}

/** Compact `Agent · model · effort` label; null when nothing is set. */
export function formatExecution(
  execution: HarnessAdminExecution,
  agents: readonly HarnessAdminAgentOption[] | null,
): string | null {
  const agent = findAgent(agents, execution.agentConfig);
  const parts = [
    agent?.name ?? execution.agentConfig,
    findModel(agent, execution.model)?.name ?? execution.model,
    execution.effort,
  ].filter((part): part is string => Boolean(part));
  return parts.length > 0 ? parts.join(" · ") : null;
}
