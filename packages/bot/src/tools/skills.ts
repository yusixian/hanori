import type { Tool } from "ai";
import { tool } from "ai";
import { z } from "zod";
import { isImagePromptSkill, type BotSkillDefinition } from "../skills/catalog.js";
import { zodToAiSchema } from "./utils.js";

export interface SkillToolsOptions {
  skills: readonly BotSkillDefinition[];
  hasImageGeneration: boolean;
  hasWebSearch: boolean;
  unifiedSearchEnabled?: boolean;
}

export function createSkillTools(options: SkillToolsOptions): Record<string, Tool> {
  if (options.skills.length === 0) return {};
  const byName = new Map(options.skills.map((skill) => [skill.name, skill]));
  const names = options.skills.map((skill) => skill.name).join(", ");
  const failures = new Map<string, number>();
  function failure(key: string, result: Record<string, unknown>) {
    const attempts = (failures.get(key) ?? 0) + 1;
    failures.set(key, attempts);
    return attempts >= 3
      ? {
          ...result,
          blocked: true,
          code: "skill_retry_limit",
          attempts,
          guidance:
            "The same Skill load failed three times in this turn. Stop tool calls and explain the missing Skill/resource. Do not claim that image generation or other work was submitted or completed.",
        }
      : result;
  }
  const retrievalCompatibility =
    "Host tool compatibility: web_search → search(scope=web); search_history → search(scope=history); search_profiles → search(scope=profiles); recall_memories → search(scope=memory); search_generation_characters → search(scope=characters,provider=builtin.characters.local); search_danbooru_character_tags → search(scope=characters,provider=builtin.characters.danbooru); search_prompt_assets → search(scope=prompt_assets); fetch_artwork_info → search(scope=artwork,query=URL). These old names are not callable here. Only use sources listed in the actual search tool; get result bodies in bounded chunks with read_reference. Bot/user/chat identities cannot be overridden.";

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
          return failure(JSON.stringify([requestedName, "skill_not_enabled"]), {
            ok: false,
            error: "skill_not_enabled",
            availableSkills: [...byName.keys()],
          });
        }
        const imagePreparation = isImagePromptSkill(skill);
        if (resource) {
          if (!Object.hasOwn(skill.resources, resource)) {
            return failure(JSON.stringify([requestedName, resource, "resource_not_found"]), {
              ok: false,
              error: "resource_not_found",
              skill: skill.name,
              imagePreparation,
              availableResources: Object.keys(skill.resources),
              guidance: imagePreparation
                ? "This is preparation only; no image has been submitted. Use a listed resource or the main Skill, then call create_image if generation is requested. Never claim completion after this error."
                : "Use a listed resource or load the main Skill. Never claim completion after this error.",
            });
          }
          const content = skill.resources[resource];
          return {
            ok: true,
            skill: skill.name,
            imagePreparation,
            resource,
            content,
            ...(options.unifiedSearchEnabled === true
              ? { runtime: { retrieval: retrievalCompatibility } }
              : {}),
          };
        }
        return {
          ok: true,
          skill: skill.name,
          imagePreparation,
          instructions: skill.instructions,
          availableResources: Object.keys(skill.resources),
          runtime: {
            siblingSkills: "Use load_skill again with the sibling Skill name.",
            ...(imagePreparation
              ? {
                  imageGeneration: options.hasImageGeneration
                    ? "In this bot, requests such as draw, generate, make me an image, or /draw mean actual image generation. Follow the skill to finish the prompt, then call create_image. Loading skills or presets is preparation only; accepted means the request was submitted, not delivered. Only a persisted Telegram receipt confirms delivery. Never infer personTelegramId from the requester or from 'draw for me'; use it only when explicitly asked to depict that person. Only return prompt text without generating when the user explicitly asks for a prompt. Treat image-tool names from other hosts, including pixai-image, as create_image."
                    : "No image-generation tool is available in this turn; provide the prompt without claiming an image was created.",
                }
              : {}),
            webSearch: options.hasWebSearch
              ? options.unifiedSearchEnabled === true
                ? "Use search with scope=web and the available web provider when the Skill requires current or official references. Read returned references with read_reference; fetch_webpage remains available when offered."
                : "web_search is available when the Skill requires current or official references."
              : options.unifiedSearchEnabled === true
                ? "search(scope=web) is unavailable in this turn; do not claim that required external research was completed."
                : "web_search is unavailable in this turn; do not claim that required external research was completed.",
            ...(options.unifiedSearchEnabled === true
              ? {
                  retrieval: retrievalCompatibility,
                }
              : {}),
          },
        };
      },
    }),
  };
}
