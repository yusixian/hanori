import { createHash } from "node:crypto";
import type { BotCustomSkillStored, BotSkillConfigStored } from "@cos-tool-bot/shared";
import data from "./builtins-data.json";

interface BuiltInSkillData {
  id: string;
  name: string;
  displayName: string;
  summary: string;
  instructions: string;
  resources: Record<string, string>;
  source: string;
}

export interface BotSkillDefinition {
  id: string;
  name: string;
  displayName: string;
  description: string;
  summary: string;
  instructions: string;
  resources: Readonly<Record<string, string>>;
  source: string;
  digest: string;
}

export interface BotSkillSummary {
  id: string;
  name: string;
  displayName: string;
  description: string;
  summary: string;
  source: string;
  digest: string;
  resources: string[];
  enabled: boolean;
}

function readFrontmatterDescription(instructions: string): string {
  const match = instructions.match(/^---\n[\s\S]*?^description:\s*(.+)$/m);
  return match?.[1]?.trim() ?? "";
}

function digestSkill(skill: BuiltInSkillData): string {
  const hash = createHash("sha256");
  hash.update(skill.instructions);
  for (const [name, content] of Object.entries(skill.resources).sort(([a], [b]) =>
    a.localeCompare(b),
  )) {
    hash.update("\0");
    hash.update(name);
    hash.update("\0");
    hash.update(content);
  }
  return hash.digest("hex").slice(0, 12);
}

const catalog = Object.freeze(
  (data as BuiltInSkillData[]).map((skill) =>
    Object.freeze({
      ...skill,
      description: readFrontmatterDescription(skill.instructions),
      resources: Object.freeze({ ...skill.resources }),
      digest: digestSkill(skill),
    }),
  ),
) satisfies readonly BotSkillDefinition[];

const byId = new Map(catalog.map((skill) => [skill.id, skill]));

export const DEFAULT_BOT_SKILL_IDS = Object.freeze(catalog.map((skill) => skill.id));

/** Missing configuration means the bundled defaults; an explicit empty array disables all Skills. */
export function resolveBuiltInSkills(configuredIds?: readonly string[]): BotSkillDefinition[] {
  const ids = configuredIds ?? DEFAULT_BOT_SKILL_IDS;
  const seen = new Set<string>();
  const resolved: BotSkillDefinition[] = [];
  for (const id of ids) {
    if (seen.has(id)) continue;
    const skill = byId.get(id);
    if (!skill) continue;
    seen.add(id);
    resolved.push(skill);
  }
  return resolved;
}

function customSkillDefinition(skill: BotCustomSkillStored): BotSkillDefinition {
  const sourceData: BuiltInSkillData = {
    id: skill.id,
    name: skill.name,
    displayName: skill.displayName,
    summary: skill.description,
    instructions: skill.instructions,
    resources: skill.resources,
    source: "custom",
  };
  return {
    ...sourceData,
    description: skill.description,
    resources: Object.freeze({ ...skill.resources }),
    digest: digestSkill(sourceData),
  };
}

export function resolveBotSkills(config?: BotSkillConfigStored): BotSkillDefinition[] {
  const builtIns = resolveBuiltInSkills(config?.enabledBuiltInIds);
  const reservedNames = new Set(catalog.map((skill) => skill.name));
  const customNames = new Set<string>();
  const custom = (config?.customSkills ?? [])
    .filter((skill) => {
      if (!skill.enabled || reservedNames.has(skill.name) || customNames.has(skill.name)) {
        return false;
      }
      customNames.add(skill.name);
      return true;
    })
    .map(customSkillDefinition);
  return [...builtIns, ...custom];
}

export function listBuiltInSkills(configuredIds?: readonly string[]): BotSkillSummary[] {
  const enabled = new Set(resolveBuiltInSkills(configuredIds).map((skill) => skill.id));
  return catalog.map((skill) => ({
    id: skill.id,
    name: skill.name,
    displayName: skill.displayName,
    description: skill.description,
    summary: skill.summary,
    source: skill.source,
    digest: skill.digest,
    resources: Object.keys(skill.resources),
    enabled: enabled.has(skill.id),
  }));
}

export function listBotSkills(config?: BotSkillConfigStored): {
  builtIns: BotSkillSummary[];
  customSkills: BotCustomSkillStored[];
} {
  return {
    builtIns: listBuiltInSkills(config?.enabledBuiltInIds),
    customSkills: (config?.customSkills ?? []).map((skill) => ({
      ...skill,
      resources: { ...skill.resources },
    })),
  };
}

export function isBuiltInSkillId(id: string): boolean {
  return byId.has(id);
}

export function buildSkillsCatalogPrompt(
  skills: readonly BotSkillDefinition[],
): string | undefined {
  if (skills.length === 0) return undefined;
  const lines = [
    "## 管理员启用的 Skills",
    "Skills 是按需加载的工作流说明，不是生图供应商。用户请求符合描述时，先调用 load_skill 读取完整说明，再按说明完成当前请求。",
    "同一请求需要兄弟 Skill 或参考资料时，可以再次调用 load_skill。实际出图仍使用 create_image，并继续受现有授权、审批、预算与限流约束。",
    "本 Bot 的集成规则高于 Skill 中针对其他宿主的工具名称或交付约定：用户明确说画、生成、来一张图片或调用 /draw 时，表示实际出图；先按 Skill 完成提示词，再调用 create_image。只有用户明确只要 prompt 时才只返回 prompt。Skill 中的 pixai-image 等生图工具名均映射为 create_image。",
    "不要把 Skill 名称、加载过程或内部路由暴露给用户，除非用户明确询问。",
    "",
    ...skills.map((skill) => `- ${skill.name}: ${skill.summary}`),
  ];
  return lines.join("\n");
}
