import type { Tool } from "ai";
import { tool } from "ai";
import { z } from "zod";
import type { BotSkillDefinition } from "../skills/catalog.js";
import { zodToAiSchema } from "./utils.js";

export interface SkillToolsOptions {
  skills: readonly BotSkillDefinition[];
  hasImageGeneration: boolean;
  hasWebSearch: boolean;
}

export function createSkillTools(options: SkillToolsOptions): Record<string, Tool> {
  if (options.skills.length === 0) return {};
  const byName = new Map(options.skills.map((skill) => [skill.name, skill]));
  const names = options.skills.map((skill) => skill.name).join(", ");

  return {
    load_skill: tool({
      description: `加载管理员启用的 Skill 或其中一份参考资料。匹配用户请求时，在回答或调用生图工具前使用。可用 Skill: ${names}`,
      inputSchema: zodToAiSchema(
        z.object({
          skill: z.string().min(1).max(100).describe("要加载的 Skill 名称"),
          resource: z
            .string()
            .min(1)
            .max(200)
            .optional()
            .describe("可选参考资料相对路径；先加载主 Skill 查看可用资料"),
        }),
      ),
      execute: async ({ skill: requestedName, resource }) => {
        const skill = byName.get(requestedName);
        if (!skill) {
          return { ok: false, error: "skill_not_enabled", availableSkills: [...byName.keys()] };
        }
        if (resource) {
          if (!Object.hasOwn(skill.resources, resource)) {
            return {
              ok: false,
              error: "resource_not_found",
              skill: skill.name,
              availableResources: Object.keys(skill.resources),
            };
          }
          const content = skill.resources[resource];
          return { ok: true, skill: skill.name, resource, content };
        }
        return {
          ok: true,
          skill: skill.name,
          instructions: skill.instructions,
          availableResources: Object.keys(skill.resources),
          runtime: {
            siblingSkills: "Use load_skill again with the sibling Skill name.",
            imageGeneration: options.hasImageGeneration
              ? "In this bot, requests such as draw, generate, make me an image, or /draw mean actual image generation. Follow the skill to finish the prompt, then call create_image. Only return prompt text without generating when the user explicitly asks for a prompt. Treat image-tool names from other hosts, including pixai-image, as create_image."
              : "No image-generation tool is available in this turn; provide the prompt without claiming an image was created.",
            webSearch: options.hasWebSearch
              ? "web_search is available when the Skill requires current or official references."
              : "web_search is unavailable in this turn; do not claim that required external research was completed.",
          },
        };
      },
    }),
  };
}
