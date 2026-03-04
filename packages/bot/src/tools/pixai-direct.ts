import type {
  BotLogEntry,
  PixAIConfig,
  PixAIGenerationRecord,
  TimeoutConfig,
  WebToolsConfig,
} from "@cos-tool-bot/shared";
import { DEFAULT_TIMEOUT_CONFIG } from "@cos-tool-bot/shared";
import type { Api } from "grammy";
import type { NsfwChecker } from "../services/nsfw-checker.js";
import type { PixAIRateLimiter } from "../services/pixai-rate-limiter.js";
import { PixAIClient, pollAndSend, resolvePrompt, PIXAI_DEFAULT_MODEL_ID } from "./pixai.js";
import type { CreateTaskParams } from "./pixai.js";

export type InferenceProfile = "standard" | "pro" | "ultra";

export const VALID_PROFILES: InferenceProfile[] = ["standard", "pro", "ultra"];

/** Profile → default priority mapping */
export const PROFILE_PRIORITY: Record<InferenceProfile, number> = {
  standard: 500,
  pro: 500,
  ultra: 1000,
};

export interface DrawOverrides {
  width?: number;
  height?: number;
  batchSize?: number;
  seed?: string;
  styleKey?: string;
  negativePrompt?: string;
  samplingSteps?: number;
  cfgScale?: number;
  promptHelper?: boolean;
  lightning?: boolean;
  inferenceProfile?: InferenceProfile;
}

export interface DirectGenerateOptions {
  getImageGenConfig: () => NonNullable<WebToolsConfig["imageGeneration"]>;
  api: Api;
  chatId: number;
  userId?: number;
  recentBotMessageIds: number[];
  timeoutConfig?: TimeoutConfig;
  onLog?: (entry: BotLogEntry) => void | Promise<void>;
  onGenerationTrack?: (record: PixAIGenerationRecord) => void | Promise<void>;
  rateLimiter?: PixAIRateLimiter;
  adminIds?: number[];
  nsfwChecker?: NsfwChecker;
}

export type DirectGenerateResult =
  | { ok: true; taskId: string; message: string }
  | { ok: true; queued: true; position: number; message: string }
  | { ok: false; error: string };

export async function directPixAIGenerate(
  rawPrompt: string,
  overrides: DrawOverrides,
  opts: DirectGenerateOptions,
): Promise<DirectGenerateResult> {
  const imgCfg = opts.getImageGenConfig();
  if (!imgCfg.apiKey) {
    return { ok: false, error: "PixAI API Key 未配置" };
  }
  const pixaiConfig: PixAIConfig = imgCfg.pixaiConfig ?? {};
  const apiMode = pixaiConfig.apiMode ?? "graphql";
  const client = new PixAIClient(imgCfg.apiKey, apiMode);
  const modelId = imgCfg.model || PIXAI_DEFAULT_MODEL_ID;
  const startTime = Date.now();

  // Resolve prompt (systemImagePrompt prefix still applies)
  const resolvedPrompt = resolvePrompt(rawPrompt, pixaiConfig);

  // Merge: inline overrides > pixaiConfig defaults > hardcoded defaults
  const resolvedWidth = overrides.width ?? pixaiConfig.width ?? 832;
  const resolvedHeight = overrides.height ?? pixaiConfig.height ?? 1472;
  const resolvedBatchSize = overrides.batchSize ?? pixaiConfig.batchSize ?? 1;
  const resolvedNegativePrompt = overrides.negativePrompt ?? pixaiConfig.negativePrompts;
  const resolvedSamplingSteps = overrides.samplingSteps ?? pixaiConfig.samplingSteps;
  const resolvedCfgScale = overrides.cfgScale ?? pixaiConfig.cfgScale;
  const resolvedModelStyle: CreateTaskParams["modelStyle"] = overrides.styleKey
    ? { type: "key", keyId: overrides.styleKey }
    : pixaiConfig.modelStyle;

  // Resolve inference profile: override > config > undefined
  const resolvedProfile =
    overrides.inferenceProfile ?? (pixaiConfig.inferenceProfile as InferenceProfile | undefined);

  // Priority: profile-derived > config > hardcoded default (500 = standard)
  const resolvedPriority = resolvedProfile
    ? PROFILE_PRIORITY[resolvedProfile]
    : (pixaiConfig.priority ?? 500);

  const taskParams: CreateTaskParams = {
    prompts: resolvedPrompt,
    modelId,
    negativePrompts: resolvedNegativePrompt,
    width: resolvedWidth,
    height: resolvedHeight,
    batchSize: resolvedBatchSize,
    samplingSteps: resolvedSamplingSteps,
    cfgScale: resolvedCfgScale,
    promptHelper: overrides.promptHelper ?? pixaiConfig.promptHelper,
    seed: overrides.seed ?? pixaiConfig.seed,
    priority: resolvedPriority,
    clipSkip: pixaiConfig.clipSkip,
    lightning: overrides.lightning ?? pixaiConfig.lightning,
    modelStyle: resolvedModelStyle,
    inferenceProfile: resolvedProfile,
    samplingMethod: pixaiConfig.samplingMethod,
    qualityTag: pixaiConfig.qualityTag,
    isPrivate: pixaiConfig.isPrivate,
  };

  const baseRecord: Omit<PixAIGenerationRecord, "status"> = {
    chatId: opts.chatId,
    userId: opts.userId,
    taskId: "",
    prompt: resolvedPrompt,
    negativePrompt: resolvedNegativePrompt,
    modelId,
    width: resolvedWidth,
    height: resolvedHeight,
    batchSize: resolvedBatchSize,
    samplingSteps: resolvedSamplingSteps,
    cfgScale: resolvedCfgScale,
    promptHelper: !!(overrides.promptHelper ?? pixaiConfig.promptHelper),
    pixaiConfig: { ...pixaiConfig, modelStyle: resolvedModelStyle },
  };

  /** Create task, register, poll in background */
  async function startTask(): Promise<DirectGenerateResult> {
    try {
      const task = await client.createTask(taskParams);
      const record = { ...baseRecord, taskId: task.id };

      opts.onLog?.({
        level: "info",
        message: `PixAI direct task created (${apiMode}): ${task.id}`,
        meta: {
          chatId: opts.chatId,
          taskId: task.id,
          apiMode,
          prompt: resolvedPrompt.slice(0, 200),
        },
      });

      opts.onGenerationTrack?.({ ...record, status: "pending" });
      opts.rateLimiter?.registerTask(task.id, opts.chatId, opts.userId);

      const taskTimeoutMs = opts.timeoutConfig?.pixaiTaskMs ?? DEFAULT_TIMEOUT_CONFIG.pixaiTaskMs;
      pollAndSend(client, task.id, taskTimeoutMs, {
        api: opts.api,
        chatId: opts.chatId,
        recentBotMessageIds: opts.recentBotMessageIds,
        prompt: resolvedPrompt,
        baseRecord: record,
        onLog: opts.onLog,
        onGenerationTrack: opts.onGenerationTrack,
        startTime,
        onDone: opts.rateLimiter ? () => opts.rateLimiter!.releaseTask(task.id) : undefined,
        nsfwChecker: opts.nsfwChecker,
      }).catch((err) => {
        const errMsg = err instanceof Error ? err.message : String(err);
        opts.onLog?.({
          level: "error",
          message: `PixAI direct task failed: ${errMsg}`,
          meta: { chatId: opts.chatId, taskId: task.id },
        });
        opts.onGenerationTrack?.({
          ...record,
          status: "failed",
          errorMessage: errMsg,
          durationMs: Date.now() - startTime,
        });
        opts.api.sendMessage(opts.chatId, `图片生成失败: ${errMsg}`).catch(() => {});
      });

      return { ok: true, taskId: task.id, message: "图片正在后台生成，完成后会自动发送" };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  // --- No rate limiter ---
  if (!opts.rateLimiter) {
    return startTask();
  }

  // --- Rate limiter flow ---
  const isAdmin = opts.userId != null && opts.adminIds?.includes(opts.userId) === true;
  const result = opts.rateLimiter.tryAcquire(opts.chatId, opts.userId, isAdmin);

  if (result.allowed) {
    return startTask();
  }

  switch (result.reason) {
    case "user_cooldown":
      return { ok: false, error: `生图冷却中，请等待 ${result.cooldownSec} 秒` };
    case "chat_cooldown":
      return { ok: false, error: `本群生图冷却中，请等待 ${result.cooldownSec} 秒` };
    case "hourly_exceeded":
      return {
        ok: false,
        error: `本小时生图次数已达上限 (${result.hourlyUsed}/${result.hourlyLimit})`,
      };
    case "concurrent_full": {
      const slot = opts.rateLimiter.enqueue(opts.chatId, opts.userId, isAdmin);
      if (!slot) {
        return { ok: false, error: "当前生图请求过多，请稍后再试" };
      }

      slot.promise
        .then(async () => {
          const res = await startTask();
          if (!res.ok) {
            await opts.api.sendMessage(opts.chatId, `排队后生图失败: ${res.error}`).catch(() => {});
          }
        })
        .catch((err) => {
          const errMsg = err instanceof Error ? err.message : String(err);
          opts.onLog?.({
            level: "warn",
            message: `PixAI direct queue slot rejected: ${errMsg}`,
            meta: { chatId: opts.chatId },
          });
          opts.api.sendMessage(opts.chatId, `排队等待超时或被取消: ${errMsg}`).catch(() => {});
        });

      return {
        ok: true,
        queued: true,
        position: slot.position,
        message: `已排队，当前第 ${slot.position} 位`,
      };
    }
    case "queue_full":
      return { ok: false, error: "当前生图请求过多，请稍后再试" };
    default:
      return { ok: false, error: "生图请求被限流，请稍后再试" };
  }
}
