import { z } from "zod";

export const EFFORTS = ["default", "low", "medium", "high", "xhigh", "max", "ultra"] as const;
export type Effort = (typeof EFFORTS)[number];

/** Must stay within the lody-bridge `--model` / `--agent` value rules. */
export const MODEL_ID_PATTERN = /^[\w.:[\]/+-]{1,120}$/;
export const AGENT_REF_PATTERN = /^[\w .:@/+-]{1,200}$/;

export const modelOptionSchema = z.strictObject({
  id: z.string().regex(MODEL_ID_PATTERN, "模型 ID 格式不正确"),
  name: z.string().min(1).max(80),
  efforts: z.array(z.enum(EFFORTS)).min(1),
});

export type ModelOption = z.infer<typeof modelOptionSchema>;

const CODEX_EFFORTS: Effort[] = ["low", "medium", "high", "xhigh", "max", "ultra"];
const CLAUDE_EFFORTS: Effort[] = ["default", "low", "medium", "high", "xhigh", "max"];

/** The CLI does not list models, so the GUI offers these; `executors.lody.models` replaces a type's list. */
export const DEFAULT_MODEL_CATALOG: Record<string, ModelOption[]> = {
  codex: [
    { id: "gpt-6-sol", name: "GPT-6 Sol", efforts: CODEX_EFFORTS },
    { id: "gpt-6-astra", name: "GPT-6 Astra", efforts: CODEX_EFFORTS },
    { id: "gpt-6-luna", name: "GPT-6 Luna", efforts: CODEX_EFFORTS.slice(0, 5) },
    { id: "gpt-5.6-sol", name: "GPT-5.6 Sol", efforts: CODEX_EFFORTS },
    { id: "gpt-5.6-terra", name: "GPT-5.6 Terra", efforts: CODEX_EFFORTS },
    { id: "gpt-5.6-luna", name: "GPT-5.6 Luna", efforts: CODEX_EFFORTS.slice(0, 5) },
    { id: "gpt-5.5", name: "GPT-5.5", efforts: CODEX_EFFORTS.slice(0, 4) },
  ],
  claude: [
    { id: "default", name: "Default (recommended)", efforts: CLAUDE_EFFORTS },
    { id: "opus[1m]", name: "Opus 5.5", efforts: CLAUDE_EFFORTS },
    { id: "claude-fable-5-1[1m]", name: "Fable 5.1", efforts: CLAUDE_EFFORTS },
    { id: "sonnet", name: "Sonnet 5", efforts: CLAUDE_EFFORTS },
    { id: "haiku", name: "Haiku 4.5", efforts: CLAUDE_EFFORTS },
  ],
};

export function modelCatalog(overrides: Record<string, ModelOption[]> = {}) {
  return { ...DEFAULT_MODEL_CATALOG, ...overrides };
}

export interface AgentConfigInfo {
  id: string;
  name: string;
  agentType: string;
  machineId: string | null;
}

export function normalizeAgentType(agentType: string): string {
  const type = agentType.toLowerCase();
  if (type.includes("codex")) return "codex";
  if (type.includes("claude")) return "claude";
  return type;
}

export function findAgentConfig(
  agents: readonly AgentConfigInfo[] | null | undefined,
  ref: string,
): AgentConfigInfo | null {
  return agents?.find((agent) => agent.id === ref) ?? agents?.find((a) => a.name === ref) ?? null;
}

/**
 * Lody reports limits per provider. An agent config may be referenced by id, so its listed
 * `agentType` decides; then the model id, then the old name heuristic.
 */
export function vendorOf(
  agent: string,
  model: string | null,
  agents?: readonly AgentConfigInfo[] | null,
): string {
  const listed = findAgentConfig(agents, agent);
  if (listed?.agentType) return normalizeAgentType(listed.agentType);
  const id = model?.toLowerCase() ?? "";
  if (/^(gpt-|o\d)/.test(id)) return "codex";
  if (/^(claude|opus|sonnet|haiku|fable)/.test(id)) return "claude";
  const name = agent.toLowerCase();
  if (name.includes("codex")) return "codex";
  if (name.includes("kimi")) return "kimi";
  if (name.includes("gemini")) return "gemini";
  return "claude";
}

export interface ExecutionSetting {
  agentConfig: string | null;
  model: string | null;
  effort: string | null;
}

export interface WorkerExecution {
  agent: string;
  /** null lets Lody pick the agent's default model. */
  model: string | null;
  effort: string | null;
  vendor: string;
}

interface ExecutionSource {
  roles: Record<string, { agent?: string; model?: string; effort?: string }>;
  executors: { lody: { agentConfig: string; models: Record<string, ModelOption[]> } };
}

/** The lead session: `roles.worker` over `executors.lody.agentConfig`, model defaulting per vendor. */
export function resolveWorkerExecution(
  config: ExecutionSource,
  agents?: readonly AgentConfigInfo[] | null,
): WorkerExecution {
  const role = config.roles.worker ?? {};
  const agent = role.agent ?? config.executors.lody.agentConfig;
  const vendor = vendorOf(agent, role.model ?? null, agents);
  const fallback = modelCatalog(config.executors.lody.models)[vendor]?.[0]?.id ?? null;
  const model = role.model ?? fallback;
  return {
    agent,
    model: model === "default" ? null : model,
    effort: role.effort ?? null,
    vendor,
  };
}

/** Sub-sessions follow the lead's vendor; the reviewer comes from the other vendor. */
export function delegateRoles(config: ExecutionSource, lead: WorkerExecution) {
  const codexLead = lead.vendor === "codex";
  return {
    subworker:
      config.roles.subworker ??
      (codexLead ? { model: "gpt-6-luna", effort: "low" } : { model: "haiku", effort: "low" }),
    reviewer:
      config.roles.reviewer ??
      (codexLead
        ? { agent: "Claude Code", model: "opus[1m]", effort: "high" }
        : { agent: "Codex", model: "gpt-6-sol", effort: "high" }),
  };
}

/** `lody session create --config-option`; the key differs per agent type. */
export function effortConfigOption(vendor: string, effort: string | null): string | null {
  if (!effort || effort === "default") return null;
  if (vendor === "codex") return `reasoning_effort=${effort}`;
  if (vendor === "claude") return `effort=${effort}`;
  return null;
}

/** Raw layer data for a stored execution setting; null fields fall through to lower layers. */
export function executionLayerData(
  setting: Partial<ExecutionSetting> | null | undefined,
): Record<string, unknown> | null {
  if (!setting) return null;
  const worker = Object.fromEntries(
    [
      ["agent", setting.agentConfig],
      ["model", setting.model],
      ["effort", setting.effort],
    ].filter(([, value]) => typeof value === "string" && value.length > 0),
  );
  return Object.keys(worker).length > 0 ? { roles: { worker } } : null;
}
