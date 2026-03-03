import type { PixAIConfig } from "@cos-tool-bot/shared";
import type { CommandMiddleware } from "grammy";
import type { WrapperContext } from "../context.js";

export interface ImgCfgCommandConfig {
  getFullConfig: () => { model: string | undefined; pixaiConfig: PixAIConfig };
  updateConfig: (updates: {
    model?: string;
    pixaiConfig?: Partial<PixAIConfig>;
  }) => void | Promise<void>;
}

// --- Flag definitions ---

interface FlagDef {
  key: string;
  field: "model" | keyof PixAIConfig;
  type: "string" | "int" | "float" | "bool";
  min?: number;
  max?: number;
  label: string;
}

const FLAG_DEFS: Record<string, FlagDef> = {
  "-m": { key: "m", field: "model", type: "string", label: "Model ID" },
  "-s": { key: "s", field: "modelStyle", type: "string", label: "Model Style Key ID" },
  "-p": { key: "p", field: "systemImagePrompt", type: "string", label: "System Prompt" },
  "-np": { key: "np", field: "negativePrompts", type: "string", label: "Negative Prompts" },
  "-w": { key: "w", field: "width", type: "int", min: 512, max: 1280, label: "Width" },
  "-h": { key: "h", field: "height", type: "int", min: 512, max: 1280, label: "Height" },
  "-b": { key: "b", field: "batchSize", type: "int", min: 1, max: 4, label: "Batch Size" },
  "-seed": { key: "seed", field: "seed", type: "string", label: "Seed" },
  "-steps": {
    key: "steps",
    field: "samplingSteps",
    type: "int",
    min: 8,
    max: 50,
    label: "Sampling Steps",
  },
  "-cfg": { key: "cfg", field: "cfgScale", type: "float", min: 1.1, max: 15, label: "CFG Scale" },
  "-private": { key: "private", field: "isPrivate", type: "bool", label: "Private Mode" },
  "-ph": { key: "ph", field: "promptHelper", type: "bool", label: "Prompt Helper" },
  "-lightning": { key: "lightning", field: "lightning", type: "bool", label: "Lightning Mode" },
};

// Sorted flags for matching: longer flags first (e.g. -np before -n)
const SORTED_FLAG_KEYS = Object.keys(FLAG_DEFS).sort((a, b) => b.length - a.length);

// Pre-compiled flag regex (use matchAll to avoid stateful lastIndex issues)
const FLAG_PATTERN = new RegExp(
  `(${SORTED_FLAG_KEYS.map((f) => f.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})\\s`,
  "g",
);

// --- Parsers ---

function parseFlags(input: string): Map<string, string> {
  const result = new Map<string, string>();

  // Find all flag positions
  const positions: Array<{ flag: string; start: number; valueStart: number }> = [];
  for (const match of input.matchAll(FLAG_PATTERN)) {
    positions.push({
      flag: match[1]!,
      start: match.index,
      valueStart: match.index + match[0].length,
    });
  }

  for (let i = 0; i < positions.length; i++) {
    const pos = positions[i]!;
    const nextStart = positions[i + 1]?.start ?? input.length;
    const value = input.slice(pos.valueStart, nextStart).trim();
    result.set(pos.flag, value);
  }

  return result;
}

function validateInt(value: string, min: number, max: number, label: string): number | string {
  const n = Number.parseInt(value, 10);
  if (Number.isNaN(n)) return `${label}: 需要整数，收到 "${value}"`;
  if (n < min || n > max) return `${label}: 范围 ${min}-${max}，收到 ${n}`;
  return n;
}

function validateFloat(value: string, min: number, max: number, label: string): number | string {
  const n = Number.parseFloat(value);
  if (Number.isNaN(n)) return `${label}: 需要数字，收到 "${value}"`;
  if (n < min || n > max) return `${label}: 范围 ${min}-${max}，收到 ${n}`;
  return n;
}

function validateBool(value: string, label: string): boolean | string {
  const v = value.toLowerCase();
  if (v === "on" || v === "true" || v === "1") return true;
  if (v === "off" || v === "false" || v === "0") return false;
  return `${label}: 需要 on/off，收到 "${value}"`;
}

// --- Config display ---

function formatConfigHtml(model: string | undefined, cfg: PixAIConfig): string {
  const lines: string[] = ["<b>当前生图配置</b>", ""];

  // Model & dimensions
  lines.push("<b>模型/尺寸</b>");
  lines.push(`  Model: <code>${model ?? "(默认)"}</code>`);
  if (cfg.modelStyle) lines.push(`  Style: <code>${cfg.modelStyle.keyId}</code>`);
  lines.push(`  Size: ${cfg.width ?? 768} × ${cfg.height ?? 1280}`);
  lines.push(`  Batch: ${cfg.batchSize ?? 1}`);
  lines.push("");

  // Sampling
  lines.push("<b>采样参数</b>");
  if (cfg.samplingSteps != null) lines.push(`  Steps: ${cfg.samplingSteps}`);
  if (cfg.cfgScale != null) lines.push(`  CFG: ${cfg.cfgScale}`);
  lines.push(`  Seed: ${cfg.seed || "(随机)"}`);
  lines.push("");

  // Prompts
  lines.push("<b>提示词</b>");
  lines.push(`  System: ${cfg.systemImagePrompt || "(无)"}`);
  lines.push(`  Negative: ${cfg.negativePrompts || "(无)"}`);
  lines.push("");

  // Switches
  lines.push("<b>开关</b>");
  lines.push(`  Private: ${cfg.isPrivate ? "on" : "off"}`);
  lines.push(`  Prompt Helper: ${cfg.promptHelper ? "on" : "off"}`);
  lines.push(`  Lightning: ${cfg.lightning ? "on" : "off"}`);

  return lines.join("\n");
}

// --- Command factory ---

export function createImgCfgCommand(cfg: ImgCfgCommandConfig): CommandMiddleware<WrapperContext> {
  return async (ctx) => {
    const input = ctx.match?.toString().trim() ?? "";

    // No args: show config
    if (!input) {
      const { model, pixaiConfig } = cfg.getFullConfig();
      await ctx.reply(formatConfigHtml(model, pixaiConfig), { parse_mode: "HTML" });
      return;
    }

    // Parse flags
    const flags = parseFlags(input);
    if (flags.size === 0) {
      await ctx.reply("无法解析参数。用法示例:\n/imgcfg -w 1024 -h 1024 -b 2");
      return;
    }

    const errors: string[] = [];
    const modelUpdate: { model?: string } = {};
    const pixaiUpdate: Partial<PixAIConfig> = {};

    for (const [flag, value] of flags) {
      const def = FLAG_DEFS[flag];
      if (!def) continue;

      if (def.field === "model") {
        modelUpdate.model = value;
        continue;
      }

      switch (def.type) {
        case "string": {
          if (def.field === "modelStyle") {
            pixaiUpdate.modelStyle = { type: "key", keyId: value };
          } else {
            (pixaiUpdate as Record<string, unknown>)[def.field] = value;
          }
          break;
        }
        case "int": {
          const result = validateInt(value, def.min!, def.max!, def.label);
          if (typeof result === "string") errors.push(result);
          else (pixaiUpdate as Record<string, unknown>)[def.field] = result;
          break;
        }
        case "float": {
          const result = validateFloat(value, def.min!, def.max!, def.label);
          if (typeof result === "string") errors.push(result);
          else (pixaiUpdate as Record<string, unknown>)[def.field] = result;
          break;
        }
        case "bool": {
          const result = validateBool(value, def.label);
          if (typeof result === "string") errors.push(result);
          else (pixaiUpdate as Record<string, unknown>)[def.field] = result;
          break;
        }
      }
    }

    if (errors.length > 0) {
      await ctx.reply("参数校验失败:\n" + errors.join("\n"));
      return;
    }

    // Apply updates
    const updates: Parameters<typeof cfg.updateConfig>[0] = {};
    if (modelUpdate.model !== undefined) updates.model = modelUpdate.model;
    if (Object.keys(pixaiUpdate).length > 0) updates.pixaiConfig = pixaiUpdate;

    await cfg.updateConfig(updates);

    // Show updated config
    const { model, pixaiConfig } = cfg.getFullConfig();
    await ctx.reply("配置已更新\n\n" + formatConfigHtml(model, pixaiConfig), {
      parse_mode: "HTML",
    });
  };
}
