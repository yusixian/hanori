import type { CommandMiddleware } from "grammy";
import type { WrapperContext } from "../context.js";
import type {
  DirectGenerateResult,
  DrawOverrides,
  InferenceProfile,
} from "../tools/pixai-direct.js";
import { IMAGE_MAX_SIZE, IMAGE_MIN_SIZE } from "@cos-tool-bot/shared";
import { VALID_PROFILES } from "../tools/pixai-direct.js";
import {
  buildFlagPattern,
  parseFlagsFromInput,
  validateBool,
  validateFloat,
  validateInt,
} from "../utils/flag-parser.js";

// --- Flag definitions for /draw (subset of imgcfg flags, no admin/config-only flags) ---

type DrawFlagDef =
  | { field: keyof DrawOverrides; type: "int"; min: number; max: number; label: string }
  | { field: keyof DrawOverrides; type: "float"; min: number; max: number; label: string }
  | { field: keyof DrawOverrides; type: "string"; label: string }
  | { field: keyof DrawOverrides; type: "bool"; label: string };

const DRAW_FLAG_DEFS: Record<string, DrawFlagDef> = {
  "-w": { field: "width", type: "int", min: IMAGE_MIN_SIZE, max: IMAGE_MAX_SIZE, label: "Width" },
  "-h": { field: "height", type: "int", min: IMAGE_MIN_SIZE, max: IMAGE_MAX_SIZE, label: "Height" },
  "-b": { field: "batchSize", type: "int", min: 1, max: 4, label: "Batch Size" },
  "-s": { field: "styleKey", type: "string", label: "Style Key" },
  "-np": { field: "negativePrompt", type: "string", label: "Negative Prompt" },
  "-seed": { field: "seed", type: "string", label: "Seed" },
  "-steps": { field: "samplingSteps", type: "int", min: 8, max: 50, label: "Steps" },
  "-cfg": { field: "cfgScale", type: "float", min: 1.1, max: 15, label: "CFG Scale" },
  "-ph": { field: "promptHelper", type: "bool", label: "Prompt Helper" },
  "-lightning": { field: "lightning", type: "bool", label: "Lightning" },
  "-profile": { field: "inferenceProfile", type: "string", label: "Profile" },
};

const FLAG_PATTERN = buildFlagPattern(Object.keys(DRAW_FLAG_DEFS));

const HELP_TEXT = `用法: /draw <提示词> [参数]

直接使用提示词生成图片，不经过 AI 处理。

可选参数:
  -w <${IMAGE_MIN_SIZE}-${IMAGE_MAX_SIZE}>          图片宽度 (默认跟随配置)
  -h <${IMAGE_MIN_SIZE}-${IMAGE_MAX_SIZE}>          图片高度 (默认跟随配置)
  -b <1-4>             单次生成数量
  -s <key>             风格 Key (发送 /imgcfg styles 查看)
  -np <text>           负面提示词
  -seed <text>         固定随机种子
  -steps <8-50>        采样步数
  -cfg <1.1-15>        CFG Scale (提示词遵循度)
  -ph <on/off>         Prompt Helper (AI 优化提示词)
  -lightning <on/off>  闪电模式 (加速生成)
  -profile <tier>      质量档位 (standard/pro/ultra)

示例:
  /draw 1girl, white dress, garden
  /draw 1girl -w 1024 -h 1024 -s korean-style
  /draw 1girl -profile ultra -steps 40`;

// --- Parsers ---

function parseOverrides(flags: Map<string, string>): {
  overrides: DrawOverrides;
  errors: string[];
} {
  const overrides: DrawOverrides = {};
  const errors: string[] = [];

  for (const [flag, value] of flags) {
    const def = DRAW_FLAG_DEFS[flag];
    if (!def) continue;

    switch (def.type) {
      case "string": {
        if (def.field === "inferenceProfile") {
          if (!VALID_PROFILES.includes(value as InferenceProfile)) {
            errors.push(`${def.label}: 需要 ${VALID_PROFILES.join("/")}，收到 "${value}"`);
          } else {
            overrides.inferenceProfile = value as InferenceProfile;
          }
        } else {
          (overrides as Record<string, unknown>)[def.field] = value;
        }
        break;
      }
      case "int": {
        const result = validateInt(value, def.min, def.max, def.label);
        if (typeof result === "string") errors.push(result);
        else (overrides as Record<string, unknown>)[def.field] = result;
        break;
      }
      case "float": {
        const result = validateFloat(value, def.min, def.max, def.label);
        if (typeof result === "string") errors.push(result);
        else (overrides as Record<string, unknown>)[def.field] = result;
        break;
      }
      case "bool": {
        const result = validateBool(value, def.label);
        if (typeof result === "string") errors.push(result);
        else (overrides as Record<string, unknown>)[def.field] = result;
        break;
      }
    }
  }

  return { overrides, errors };
}

// --- Command factory ---

export interface DrawCommandConfig {
  directGenerate: (
    rawPrompt: string,
    overrides: DrawOverrides,
    chatId: number,
    userId?: number,
  ) => Promise<DirectGenerateResult>;
  canUseImageGeneration: (isPrivate: boolean, isAdmin: boolean, chatId: number) => boolean;
  adminIds: number[];
}

export function createDrawCommand(cfg: DrawCommandConfig): CommandMiddleware<WrapperContext> {
  return async (ctx) => {
    const chatId = ctx.chat?.id;
    if (!chatId) return;

    const input = ctx.match?.toString().trim() ?? "";

    // No args: show help
    if (!input) {
      await ctx.reply(HELP_TEXT);
      return;
    }

    // Permission check
    const isPrivate = ctx.chat?.type === "private";
    const userId = ctx.from?.id;
    const isAdmin = userId != null && cfg.adminIds.includes(userId);

    if (!cfg.canUseImageGeneration(isPrivate, isAdmin, chatId)) {
      if (isPrivate) {
        await ctx.reply("私聊中仅管理员可使用生图功能。");
      } else {
        await ctx.reply("当前群组未开启生图权限。管理员可使用 /imagegen on 开启。");
      }
      return;
    }

    // Parse prompt and flags
    const { preamble: prompt, flags } = parseFlagsFromInput(input, FLAG_PATTERN);

    if (!prompt) {
      await ctx.reply("请提供提示词。用法: /draw <提示词> [参数]\n\n发送 /draw 查看完整帮助。");
      return;
    }

    // Parse overrides
    const { overrides, errors } = parseOverrides(flags);
    if (errors.length > 0) {
      await ctx.reply("参数校验失败:\n" + errors.join("\n"));
      return;
    }

    // Execute
    const result = await cfg.directGenerate(prompt, overrides, chatId, userId);

    if (result.ok) {
      await ctx.reply(result.message);
    } else {
      await ctx.reply(`生图失败: ${result.error}`);
    }
  };
}
