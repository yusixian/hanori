import type { PixAIConfig, PixAIRateLimitConfig } from "@cos-tool-bot/shared";
import { DEFAULT_PIXAI_RATE_LIMIT } from "@cos-tool-bot/shared";
import type { CommandMiddleware } from "grammy";
import type { RateLimitStats } from "../services/pixai-rate-limiter.js";
import type { WrapperContext } from "../context.js";

export interface ImgCfgCommandConfig {
  getFullConfig: () => { model: string | undefined; pixaiConfig: PixAIConfig };
  updateConfig: (updates: {
    model?: string;
    pixaiConfig?: Partial<PixAIConfig>;
  }) => void | Promise<void>;
  getRateLimitStats?: () => RateLimitStats;
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

interface RateLimitFlagDef {
  key: string;
  field: keyof PixAIRateLimitConfig;
  type: "int" | "bool";
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

const RL_FLAG_DEFS: Record<string, RateLimitFlagDef> = {
  "-rl.max": {
    key: "rl.max",
    field: "maxConcurrentTasks",
    type: "int",
    min: 1,
    max: 20,
    label: "Max Concurrent",
  },
  "-rl.queue": {
    key: "rl.queue",
    field: "maxQueueDepth",
    type: "int",
    min: 0,
    max: 50,
    label: "Queue Depth",
  },
  "-rl.user": {
    key: "rl.user",
    field: "userCooldownSec",
    type: "int",
    min: 0,
    max: 3600,
    label: "User Cooldown (s)",
  },
  "-rl.chat": {
    key: "rl.chat",
    field: "chatCooldownSec",
    type: "int",
    min: 0,
    max: 3600,
    label: "Chat Cooldown (s)",
  },
  "-rl.hourly": {
    key: "rl.hourly",
    field: "hourlyLimit",
    type: "int",
    min: 1,
    max: 1000,
    label: "Hourly Limit",
  },
  "-rl.admin": {
    key: "rl.admin",
    field: "adminBypass",
    type: "bool",
    label: "Admin Bypass",
  },
};

// Merge all flag keys for regex
const ALL_FLAG_KEYS = [...Object.keys(FLAG_DEFS), ...Object.keys(RL_FLAG_DEFS)].sort(
  (a, b) => b.length - a.length,
);

// Pre-compiled flag regex (use matchAll to avoid stateful lastIndex issues)
const FLAG_PATTERN = new RegExp(
  `(${ALL_FLAG_KEYS.map((f) => f.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})\\s`,
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

function formatConfigHtml(
  model: string | undefined,
  cfg: PixAIConfig,
  stats?: RateLimitStats,
): string {
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
  lines.push("");

  // Rate limit config
  const rl = cfg.rateLimit ?? {};
  const d = DEFAULT_PIXAI_RATE_LIMIT;
  lines.push("<b>限流配置</b>");
  lines.push(`  并发上限: ${rl.maxConcurrentTasks ?? d.maxConcurrentTasks}`);
  lines.push(`  队列深度: ${rl.maxQueueDepth ?? d.maxQueueDepth}`);
  lines.push(`  用户冷却: ${rl.userCooldownSec ?? d.userCooldownSec}s`);
  lines.push(`  群聊冷却: ${rl.chatCooldownSec ?? d.chatCooldownSec}s`);
  lines.push(`  每小时限额: ${rl.hourlyLimit ?? d.hourlyLimit}`);
  lines.push(`  管理员绕过: ${(rl.adminBypass ?? d.adminBypass) ? "on" : "off"}`);

  // Runtime stats
  if (stats) {
    lines.push("");
    lines.push("<b>运行时状态</b>");
    lines.push(`  活跃任务: ${stats.active}/${stats.maxConcurrent}`);
    lines.push(`  排队中: ${stats.queued}/${stats.maxQueue}`);
    lines.push(`  本小时已用: ${stats.hourlyUsed}/${stats.hourlyLimit}`);
  }

  return lines.join("\n");
}

// --- Command factory ---

export function createImgCfgCommand(cfg: ImgCfgCommandConfig): CommandMiddleware<WrapperContext> {
  return async (ctx) => {
    const input = ctx.match?.toString().trim() ?? "";

    // No args: show config
    if (!input) {
      const { model, pixaiConfig } = cfg.getFullConfig();
      const stats = cfg.getRateLimitStats?.();
      await ctx.reply(formatConfigHtml(model, pixaiConfig, stats), { parse_mode: "HTML" });
      return;
    }

    // Parse flags
    const flags = parseFlags(input);
    if (flags.size === 0) {
      await ctx.reply(
        "无法解析参数。用法示例:\n/imgcfg -w 1024 -h 1024 -b 2\n/imgcfg -rl.user 120 -rl.hourly 20",
      );
      return;
    }

    const errors: string[] = [];
    const modelUpdate: { model?: string } = {};
    const pixaiUpdate: Partial<PixAIConfig> = {};
    const rlUpdate: Partial<PixAIRateLimitConfig> = {};

    for (const [flag, value] of flags) {
      // Check rate limit flags first (they start with -rl.)
      const rlDef = RL_FLAG_DEFS[flag];
      if (rlDef) {
        switch (rlDef.type) {
          case "int": {
            const result = validateInt(value, rlDef.min!, rlDef.max!, rlDef.label);
            if (typeof result === "string") errors.push(result);
            else (rlUpdate as Record<string, unknown>)[rlDef.field] = result;
            break;
          }
          case "bool": {
            const result = validateBool(value, rlDef.label);
            if (typeof result === "string") errors.push(result);
            else (rlUpdate as Record<string, unknown>)[rlDef.field] = result;
            break;
          }
        }
        continue;
      }

      // Check standard flags
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

    // Merge rate limit updates into pixaiUpdate
    if (Object.keys(rlUpdate).length > 0) {
      pixaiUpdate.rateLimit = rlUpdate;
    }

    // Apply updates
    const updates: Parameters<typeof cfg.updateConfig>[0] = {};
    if (modelUpdate.model !== undefined) updates.model = modelUpdate.model;
    if (Object.keys(pixaiUpdate).length > 0) updates.pixaiConfig = pixaiUpdate;

    await cfg.updateConfig(updates);

    // Show updated config
    const { model, pixaiConfig } = cfg.getFullConfig();
    const stats = cfg.getRateLimitStats?.();
    await ctx.reply("配置已更新\n\n" + formatConfigHtml(model, pixaiConfig, stats), {
      parse_mode: "HTML",
    });
  };
}
