import type {
  AssetSafety,
  CharacterRelation,
  GenerationLibraryActor,
  GenerationLibraryPort,
  PromptAssetType,
} from "@cos-tool-bot/shared";
import type { Tool } from "ai";
import { tool } from "ai";
import { z } from "zod";
import { zodToAiSchema } from "./utils.js";

export interface GenerationLibraryToolOptions {
  port: GenerationLibraryPort;
  getActor: () => GenerationLibraryActor;
  /** Background continuations and researchers may inspect but cannot perform CRUD or binding writes. */
  readOnly?: boolean;
}

const characterSearchSchema = z.object({
  search: z.string().trim().min(1).max(160).describe("角色名称、规范 tag 或别名"),
  page: z.number().int().min(1).default(1),
  limit: z.number().int().min(1).max(20).default(10),
});

const originalCharacterSchema = z.object({
  id: z.number().int().positive().optional().describe("仅更新明确选中的已有原创角色时填写"),
  name: z.string().trim().min(1).max(160),
  aliases: z.array(z.string().trim().min(1).max(160)).max(50).default([]),
  appearance: z.string().trim().min(1).max(4_000).describe("稳定、可复用的外貌特征"),
  defaultOutfit: z.string().trim().max(2_000).default(""),
  notes: z.string().trim().max(4_000).default(""),
  copyright: z.string().trim().max(200).optional().describe("可选的作品或世界观名称"),
});

const relationSchema = z.enum(["representation", "favorite"]);
const assetTypeSchema = z.enum(["artist_string", "style", "outfit", "trait", "composition"]);
const safetySchema = z.enum(["safe", "nsfw"]);

function resolveWriteTargetTelegramId(
  actor: GenerationLibraryActor,
  requestedTelegramId?: number,
): number | undefined {
  const target = requestedTelegramId ?? actor.telegramUserId;
  if (target === undefined) return undefined;
  if (target !== actor.telegramUserId && !actor.isAdmin) return undefined;
  return target;
}

export function createGenerationLibraryTools({
  port,
  getActor,
  readOnly = false,
}: GenerationLibraryToolOptions): Record<string, Tool> {
  const tools: Record<string, Tool> = {
    search_generation_characters: tool({
      description:
        "检索当前 Bot 已保存的角色（包括原创角色和此前沉淀的 Danbooru 角色）。这是本地资产库，结果中的外部资料可能来自较早抓取；需要最新或未入库的 Danbooru 候选时使用 search_danbooru_character_tags。每次成功检索会增加返回角色的查询命中次数。",
      inputSchema: zodToAiSchema(characterSearchSchema),
      execute: async ({ search, page, limit }) => ({
        source: "local_generation_library",
        freshness: "stored",
        ...(await port.listCharacters(getActor(), { search, page, limit }, true)),
      }),
    }),
    save_original_character: tool({
      description:
        "仅在用户明确要求“记住/保存/更新这个原创角色”时创建或更新 OC。普通聊天中的角色描写不得自动保存。更新时必须先检索并使用明确选中的 id；同名不能视为同一角色。Danbooru 来源字段不能通过此工具修改。",
      inputSchema: zodToAiSchema(originalCharacterSchema),
      execute: async ({ id, name, aliases, appearance, defaultOutfit, notes, copyright }) => ({
        character: await port.saveCharacter(
          getActor(),
          {
            name,
            aliases,
            appearance,
            defaultOutfit,
            notes,
            ...(copyright ? { copyright } : {}),
          },
          id,
        ),
      }),
    }),
    delete_generation_character: tool({
      description:
        "仅在用户明确要求删除且已经通过检索确认角色 id 后使用。删除会解除相关 people 绑定；服务端会校验角色所有权或管理员权限。",
      inputSchema: zodToAiSchema(z.object({ id: z.number().int().positive() })),
      execute: async ({ id }) => {
        await port.deleteCharacter(getActor(), id);
        return { deleted: true, id };
      },
    }),
    get_character_bindings: tool({
      description:
        "读取本人或用户明确提到的群友所绑定的代表形象与喜爱角色。指定他人时提供 telegramId；服务端按 people 隐私模式决定是否可见。绑定资料来自当前 Bot 的本地档案。",
      inputSchema: zodToAiSchema(
        z.object({
          telegramId: z.number().int().positive().optional().describe("明确读取某位群友时填写"),
        }),
      ),
      execute: async ({ telegramId }) => {
        const actor = getActor();
        const target = telegramId ?? actor.telegramUserId;
        if (target === undefined) return { error: "当前事件没有可用的用户身份。" };
        return { telegramId: target, bindings: await port.getBindings(actor, target) };
      },
    }),
    set_character_binding: tool({
      description:
        "仅在用户明确要求绑定角色或设置默认代表形象时使用。普通用户只能维护自己；管理员可在明确请求下代管指定 telegramId。喜爱角色不会自动成为本人形象。",
      inputSchema: zodToAiSchema(
        z.object({
          telegramId: z.number().int().positive().optional().describe("管理员代管指定群友时填写"),
          characterId: z.number().int().positive(),
          relation: relationSchema,
          isDefault: z.boolean().default(false).describe("仅代表形象需要默认项；服务端保证唯一"),
        }),
      ),
      execute: async ({ telegramId, characterId, relation, isDefault }) => {
        const actor = getActor();
        const target = resolveWriteTargetTelegramId(actor, telegramId);
        if (target === undefined)
          return { error: "无权修改该群友的角色绑定，或当前事件没有用户身份。" };
        await port.setBinding(actor, target, {
          characterId,
          relation: relation as CharacterRelation,
          isDefault,
        });
        return { saved: true, telegramId: target, characterId, relation, isDefault };
      },
    }),
    remove_character_binding: tool({
      description:
        "仅在用户明确要求解除绑定时使用。解除绑定不会删除角色。普通用户只能维护自己；管理员可在明确请求下代管指定 telegramId。",
      inputSchema: zodToAiSchema(
        z.object({
          telegramId: z.number().int().positive().optional().describe("管理员代管指定群友时填写"),
          characterId: z.number().int().positive(),
          relation: relationSchema,
        }),
      ),
      execute: async ({ telegramId, characterId, relation }) => {
        const actor = getActor();
        const target = resolveWriteTargetTelegramId(actor, telegramId);
        if (target === undefined)
          return { error: "无权修改该群友的角色绑定，或当前事件没有用户身份。" };
        await port.removeBinding(actor, target, characterId, relation as CharacterRelation);
        return { removed: true, telegramId: target, characterId, relation };
      },
    }),
    search_prompt_assets: tool({
      description:
        "检索当前 Bot 的提示词资产。返回的是本地维护内容；检索本身不代表本次生成已经采用，也不会增加成功使用次数。仅在用户本次明确要求 NSFW 时检索 nsfw；真正注入时服务端仍会校验安全设置。",
      inputSchema: zodToAiSchema(
        z.object({
          search: z.string().trim().max(160).optional(),
          type: assetTypeSchema.optional(),
          safety: safetySchema.optional(),
          page: z.number().int().min(1).default(1),
          limit: z.number().int().min(1).max(20).default(10),
        }),
      ),
      execute: async ({ search, type, safety, page, limit }) => ({
        source: "local_generation_library",
        ...(await port.listAssets(getActor(), {
          ...(search ? { search } : {}),
          ...(type ? { type: type as PromptAssetType } : {}),
          ...(safety ? { safety: safety as AssetSafety } : {}),
          page,
          limit,
        })),
      }),
    }),
  };

  if (!readOnly && getActor().isAdmin) {
    tools.save_prompt_asset = tool({
      description:
        "仅供 Bot 管理员在明确要求保存或更新提示词资产时使用。更新必须提供已检索确认的 id；不得根据相似名称或内容自动合并。pinned 只是管理标记，是否自动注入由服务端设置决定。",
      inputSchema: zodToAiSchema(
        z.object({
          id: z.number().int().positive().optional(),
          name: z.string().trim().min(1).max(160),
          type: assetTypeSchema,
          content: z.string().trim().min(1).max(8_000),
          notes: z.string().trim().max(4_000).default(""),
          safety: safetySchema,
          pinned: z.boolean().default(false),
        }),
      ),
      execute: async ({ id, name, type, content, notes, safety, pinned }) => ({
        asset: await port.saveAsset(
          getActor(),
          {
            name,
            type: type as PromptAssetType,
            content,
            notes,
            safety: safety as AssetSafety,
            pinned,
          },
          id,
        ),
      }),
    });
    tools.delete_prompt_asset = tool({
      description:
        "仅供 Bot 管理员在明确要求删除且已确认资产 id 后使用。历史生成仍保留当时采用的内容快照。",
      inputSchema: zodToAiSchema(z.object({ id: z.number().int().positive() })),
      execute: async ({ id }) => {
        await port.deleteAsset(getActor(), id);
        return { deleted: true, id };
      },
    });
  }

  if (readOnly) {
    delete tools.save_original_character;
    delete tools.delete_generation_character;
    delete tools.set_character_binding;
    delete tools.remove_character_binding;
  }

  return tools;
}
