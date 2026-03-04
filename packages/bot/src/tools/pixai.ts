import type {
  BotLogEntry,
  NsfwScores,
  PixAIConfig,
  PixAIGenerationRecord,
  TimeoutConfig,
  WebToolsConfig,
} from "@cos-tool-bot/shared";
import { DEFAULT_TIMEOUT_CONFIG, IMAGE_MAX_SIZE, IMAGE_MIN_SIZE } from "@cos-tool-bot/shared";
import type { Tool } from "ai";
import { tool } from "ai";
import type { Api } from "grammy";
import { z } from "zod";
import type { NsfwChecker } from "../services/nsfw-checker.js";
import type { PixAIRateLimiter } from "../services/pixai-rate-limiter.js";
import { sleep } from "../utils/sleep.js";
import { zodToAiSchema } from "./utils.js";

/** Default model ID: Tsubaki v1.1 */
export const PIXAI_DEFAULT_MODEL_ID = "1935090615918113018";

// --- PixAI API endpoints ---

const PIXAI_REST_URL = "https://api.pixai.art/v1";
const GRAPHQL_ENDPOINT = "https://api.pixai.art/graphql";

// --- GraphQL documents ---

const CREATE_TASK_MUTATION = `
mutation createGenerationTask($parameters: JSONObject!) {
  createGenerationTask(parameters: $parameters) {
    id
    status
    outputs
  }
}`;

const GET_TASK_QUERY = `
query getTaskById($id: ID!) {
  task(id: $id) {
    id
    status
    outputs
    media {
      id
      urls {
        variant
        url
      }
    }
  }
}`;

// --- Types ---

interface TaskPollResult {
  urls: string[];
  mediaIds: string[];
}

interface PixAITaskResponse {
  id: string;
  status: string;
  outputs?: {
    mediaUrls?: Array<string | null>;
    mediaIds?: Array<string | null>;
    batch?: Array<{ mediaId?: string }>;
    mediaId?: string;
  };
  error?: string;
  media?: Array<{
    id: string;
    urls: Array<{ variant: string; url: string }>;
  }>;
}

interface GraphQLResponse<T> {
  data?: T;
  errors?: Array<{ message: string }>;
}

// --- PixAI Client (dual-mode: GraphQL + REST) ---

type ApiMode = "graphql" | "rest";

function buildPromptHelperParam(enabled?: boolean) {
  if (!enabled) return undefined;
  return { withStage: true, userWantToEnable: true, enable: true };
}

export interface CreateTaskParams {
  prompts: string;
  modelId: string;
  negativePrompts?: string;
  width?: number;
  height?: number;
  batchSize?: number;
  samplingSteps?: number;
  cfgScale?: number;
  promptHelper?: boolean;
  seed?: string;
  priority?: number;
  clipSkip?: number;
  lightning?: boolean;
  controlNets?: unknown[];
  modelStyle?: { type: "key"; keyId: string };
  inferenceProfile?: string;
  samplingMethod?: string;
  qualityTag?: { prefix: string; suffix: string };
  isPrivate?: boolean;
}

export class PixAIClient {
  constructor(
    private apiKey: string,
    private apiMode: ApiMode = "graphql",
  ) {}

  async createTask(params: CreateTaskParams): Promise<PixAITaskResponse> {
    if (this.apiMode === "graphql") {
      return this.createTaskGraphQL(params);
    }
    return this.createTaskREST(params);
  }

  async getTask(taskId: string): Promise<PixAITaskResponse> {
    if (this.apiMode === "graphql") {
      return this.getTaskGraphQL(taskId);
    }
    return this.getTaskREST(taskId);
  }

  async pollUntilComplete(
    taskId: string,
    timeoutMs: number,
    intervalMs = 5000,
  ): Promise<TaskPollResult> {
    const deadline = Date.now() + timeoutMs;

    // Initial delay: image generation takes several seconds at minimum
    await sleep(intervalMs);

    while (Date.now() < deadline) {
      const task = await this.getTask(taskId);

      if (task.status === "failed" || task.status === "cancelled") {
        throw new Error(`PixAI task ${task.status}: ${task.error ?? "unknown error"}`);
      }

      if (task.status === "completed") {
        return this.extractImagesFromTask(task);
      }

      // Still waiting/running — sleep then retry
      await sleep(intervalMs);
    }

    throw new Error(`PixAI task timed out after ${timeoutMs / 1000}s`);
  }

  // --- Private: GraphQL ---

  private async createTaskGraphQL(params: CreateTaskParams): Promise<PixAITaskResponse> {
    const parameters: Record<string, unknown> = {
      prompts: params.prompts,
      modelId: params.modelId,
      negativePrompts: params.negativePrompts || "",
      width: params.width ?? 832,
      height: params.height ?? 1472,
      batchSize: params.batchSize ?? 1,
      priority: params.priority ?? 1000,
      seed: params.seed ?? "",
      clipSkip: params.clipSkip ?? 2,
      lightning: params.lightning ?? false,
      controlNets: params.controlNets ?? [],
      promptHelper: buildPromptHelperParam(params.promptHelper),
      extra: {
        naturalPrompts: params.prompts,
      },
    };

    // Optional parameters — only include when explicitly set
    if (params.samplingSteps != null) parameters.samplingSteps = params.samplingSteps;
    if (params.cfgScale != null) parameters.cfgScale = params.cfgScale;
    if (params.modelStyle) parameters.modelStyle = params.modelStyle;
    if (params.inferenceProfile) parameters.inferenceProfile = params.inferenceProfile;
    if (params.samplingMethod) parameters.samplingMethod = params.samplingMethod;
    if (params.qualityTag) parameters.qualityTag = params.qualityTag;
    if (params.isPrivate != null) parameters.isPrivate = params.isPrivate;

    const res = await fetch(GRAPHQL_ENDPOINT, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({
        query: CREATE_TASK_MUTATION,
        variables: { parameters },
      }),
    });

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`PixAI GraphQL create task failed: HTTP ${res.status} ${text}`);
    }

    const json = (await res.json()) as GraphQLResponse<{
      createGenerationTask: PixAITaskResponse;
    }>;

    if (json.errors?.length) {
      throw new Error(`PixAI GraphQL error: ${json.errors.map((e) => e.message).join(", ")}`);
    }

    if (!json.data?.createGenerationTask) {
      throw new Error("PixAI GraphQL create task: unexpected empty response");
    }
    return json.data.createGenerationTask;
  }

  private async getTaskGraphQL(taskId: string): Promise<PixAITaskResponse> {
    const res = await fetch(GRAPHQL_ENDPOINT, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({
        query: GET_TASK_QUERY,
        variables: { id: taskId },
      }),
    });

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`PixAI GraphQL get task failed: HTTP ${res.status} ${text}`);
    }

    const json = (await res.json()) as GraphQLResponse<{ task: PixAITaskResponse }>;

    if (json.errors?.length) {
      throw new Error(`PixAI GraphQL error: ${json.errors.map((e) => e.message).join(", ")}`);
    }

    if (!json.data?.task) {
      throw new Error("PixAI GraphQL get task: unexpected empty response");
    }
    return json.data.task;
  }

  // --- Private: REST ---

  private async createTaskREST(params: CreateTaskParams): Promise<PixAITaskResponse> {
    const body = {
      parameters: {
        prompts: params.prompts,
        modelId: params.modelId,
        negativePrompts: params.negativePrompts || "",
        width: params.width ?? 832,
        height: params.height ?? 1472,
        batchSize: params.batchSize ?? 1,
        samplingSteps: params.samplingSteps ?? 20,
        cfgScale: params.cfgScale ?? 5,
        promptHelper: buildPromptHelperParam(params.promptHelper),
      },
    };

    const res = await fetch(`${PIXAI_REST_URL}/task`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`PixAI create task failed: HTTP ${res.status} ${text}`);
    }

    return (await res.json()) as PixAITaskResponse;
  }

  private async getTaskREST(taskId: string): Promise<PixAITaskResponse> {
    const res = await fetch(`${PIXAI_REST_URL}/task/${taskId}`, {
      headers: { Authorization: `Bearer ${this.apiKey}` },
    });

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`PixAI get task failed: HTTP ${res.status} ${text}`);
    }

    return (await res.json()) as PixAITaskResponse;
  }

  // --- Private: Image extraction ---

  private extractImagesFromTask(task: PixAITaskResponse): TaskPollResult {
    const mediaIds: string[] = [];
    const urls: string[] = [];

    // 1. Try outputs.batch[].mediaId (GraphQL multi-image)
    if (task.outputs?.batch) {
      for (const item of task.outputs.batch) {
        if (item.mediaId) mediaIds.push(item.mediaId);
      }
    }

    // 2. Try outputs.mediaId (GraphQL single-image)
    if (task.outputs?.mediaId && mediaIds.length === 0) {
      mediaIds.push(task.outputs.mediaId);
    }

    // 3. Try task.media[].urls where variant === "PUBLIC"
    if (task.media?.length) {
      for (const m of task.media) {
        const pub = m.urls.find((u) => u.variant === "PUBLIC");
        if (pub) {
          urls.push(pub.url);
          if (!mediaIds.includes(m.id)) mediaIds.push(m.id);
        }
      }
    }

    if (urls.length > 0) return { urls, mediaIds };

    // 4. Try REST-style outputs.mediaUrls
    const restUrls = (task.outputs?.mediaUrls ?? []).filter(
      (u): u is string => u != null && u !== "",
    );
    if (restUrls.length > 0) {
      // Also collect REST mediaIds
      const restMediaIds = (task.outputs?.mediaIds ?? []).filter(
        (id): id is string => id != null && id !== "",
      );
      return {
        urls: restUrls,
        mediaIds: restMediaIds.length > 0 ? restMediaIds : mediaIds,
      };
    }

    // 5. Fallback: construct URLs from mediaIds
    if (mediaIds.length > 0) {
      return {
        urls: mediaIds.map((id) => `${PIXAI_REST_URL}/media/${id}/image`),
        mediaIds,
      };
    }

    throw new Error("PixAI task completed but no images returned");
  }
}

// --- Tool factory ---

export interface PixAIToolsOptions {
  config: NonNullable<WebToolsConfig["imageGeneration"]>;
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

export function resolvePrompt(prompt: string, pixaiConfig: PixAIConfig): string {
  if (pixaiConfig.systemImagePrompt) {
    return `${pixaiConfig.systemImagePrompt}, ${prompt}`;
  }
  return prompt;
}

export function createPixAITool(options: PixAIToolsOptions): Record<string, Tool> {
  const {
    config,
    api,
    chatId,
    userId,
    recentBotMessageIds,
    timeoutConfig,
    onLog,
    onGenerationTrack,
    rateLimiter,
    adminIds,
    nsfwChecker,
  } = options;
  const pixaiConfig = config.pixaiConfig ?? {};
  const apiMode: ApiMode = pixaiConfig.apiMode ?? "graphql";
  const client = new PixAIClient(config.apiKey!, apiMode);
  const modelId = config.model || PIXAI_DEFAULT_MODEL_ID;

  /** Shared logic: create task, register, poll & send */
  function startTaskInBackground(
    resolvedParams: CreateTaskParams,
    ctx: {
      resolvedPrompt: string;
      resolvedWidth: number;
      resolvedHeight: number;
      resolvedBatchSize: number;
      resolvedNegativePrompt?: string;
      resolvedSamplingSteps?: number;
      resolvedCfgScale?: number;
      resolvedModelStyle?: CreateTaskParams["modelStyle"];
      startTime: number;
    },
  ): Promise<{ taskId: string; status: string; message: string }> {
    return client.createTask(resolvedParams).then((task) => {
      const configSnapshot: PixAIConfig = {
        ...pixaiConfig,
        modelStyle: ctx.resolvedModelStyle,
      };

      const baseRecord: Omit<PixAIGenerationRecord, "status"> = {
        chatId,
        userId,
        taskId: task.id,
        prompt: ctx.resolvedPrompt,
        negativePrompt: ctx.resolvedNegativePrompt,
        modelId,
        width: ctx.resolvedWidth,
        height: ctx.resolvedHeight,
        batchSize: ctx.resolvedBatchSize,
        samplingSteps: ctx.resolvedSamplingSteps,
        cfgScale: ctx.resolvedCfgScale,
        promptHelper: !!pixaiConfig.promptHelper,
        pixaiConfig: configSnapshot,
      };

      onLog?.({
        level: "info",
        message: `PixAI task created (${apiMode}): ${task.id}`,
        meta: { chatId, taskId: task.id, apiMode, prompt: ctx.resolvedPrompt.slice(0, 200) },
      });

      onGenerationTrack?.({ ...baseRecord, status: "pending" });

      rateLimiter?.registerTask(task.id, chatId, userId);

      const taskTimeoutMs = timeoutConfig?.pixaiTaskMs ?? DEFAULT_TIMEOUT_CONFIG.pixaiTaskMs;
      pollAndSend(client, task.id, taskTimeoutMs, {
        api,
        chatId,
        recentBotMessageIds,
        prompt: ctx.resolvedPrompt,
        baseRecord,
        onLog,
        onGenerationTrack,
        startTime: ctx.startTime,
        onDone: rateLimiter ? () => rateLimiter.releaseTask(task.id) : undefined,
        nsfwChecker,
      }).catch((err) => {
        const errMsg = err instanceof Error ? err.message : String(err);
        onLog?.({
          level: "error",
          message: `PixAI background task failed: ${errMsg}`,
          meta: { chatId, taskId: task.id },
        });
        onGenerationTrack?.({
          ...baseRecord,
          status: "failed",
          errorMessage: errMsg,
          durationMs: Date.now() - ctx.startTime,
        });
        api.sendMessage(chatId, `图片生成失败: ${errMsg}`).catch((sendErr) => {
          onLog?.({
            level: "warn",
            message: `Failed to notify user about PixAI error: ${sendErr}`,
            meta: { chatId, taskId: task.id },
          });
        });
      });

      return {
        taskId: task.id,
        status: "started",
        message: "图片正在后台生成，完成后会自动发送到聊天",
      };
    });
  }

  return {
    generate_image: tool({
      description:
        "使用 PixAI 生成高质量 AI 图片。图片会在后台生成完成后自动发送到聊天，无需调用 send_photo。",
      inputSchema: zodToAiSchema(
        z.object({
          prompt: z
            .string()
            .max(4096)
            .describe(
              "图片描述提示词，支持自然语言描述（英文效果更佳）。必须保留用户明确要求的重要特征（如正字标记、特定文字内容、具体姿势、服装细节等），不要擅自省略或改写这些关键要求。用户处于简体中文环境，涉及文字内容时默认为简体中文。",
            ),
          negative_prompt: z.string().max(4096).optional().describe("负面提示词"),
          width: z
            .number()
            .int()
            .min(IMAGE_MIN_SIZE)
            .max(IMAGE_MAX_SIZE)
            .optional()
            .describe(`图片宽度 (${IMAGE_MIN_SIZE}-${IMAGE_MAX_SIZE})`),
          height: z
            .number()
            .int()
            .min(IMAGE_MIN_SIZE)
            .max(IMAGE_MAX_SIZE)
            .optional()
            .describe(`图片高度 (${IMAGE_MIN_SIZE}-${IMAGE_MAX_SIZE})`),
          batch_size: z.number().int().min(1).max(4).optional().describe("生成数量 (1-4)"),
          seed: z.string().optional().describe("随机种子（留空=随机）"),
          style_key: z
            .string()
            .optional()
            .describe(
              [
                "可选风格 key，根据画面需要选择最合适的风格。可选值:",
                "low-saturation-expressive-eyes(低饱和透明感)",
                "colored-pencil-grain(缤纷彩铅)",
                "grey-blocks-lineless(灰色晕染)",
                "oil-watercolor-blend(水感油彩)",
                "hard-line-monochrome-accent(极简时尚)",
                "korean-style(精致韩漫)",
                "lineart-watercolor-airy(柔光线条)",
                "minimal-flat-color(极简色块)",
                "luminous-retro-impasto(明亮厚涂)",
                "anime-watercolor-impasto(水彩光晕)",
                "high-contrast-retro-vivid(明亮霓虹)",
                "flat-anime-pastel(柔和平涂)",
                "paper-watercolor(亮系水彩)",
                "classic-japanese(经典动画)",
                "retro-tv-anime(90复古赛璐璐)",
                "poster-graffiti(霓彩海报)",
                "clean-flat-illustration(简约平涂)",
                "art-crayon(画艺蜡笔)",
                "painterly-doodle(纹理涂鸦)",
                "retro-comic-fusion(复古混搭)",
                "pencil-sketch(铅绘素描)",
                "chibi(Q版)",
                "retro-oil-glamour(复古油亮肉感，适合性感/涩图)",
                "modern-oil-glamour(现代油亮肉感，适合性感/涩图)",
                "bold-line-soft-color(厚线柔和)",
                "glossy-glass-anime(琉璃动画)",
                "moe-pastel(萌系平涂)",
                "semi-realistic(半写实)",
                "cool-warm-oil-contrast(撞色厚涂)",
              ].join(" / "),
            ),
        }),
      ),
      execute: async ({ prompt, negative_prompt, width, height, batch_size, seed, style_key }) => {
        const startTime = Date.now();
        const resolvedPrompt = resolvePrompt(prompt, pixaiConfig);
        const resolvedWidth = width ?? pixaiConfig.width ?? 832;
        const resolvedHeight = height ?? pixaiConfig.height ?? 1472;
        const resolvedBatchSize = batch_size ?? pixaiConfig.batchSize ?? 1;
        const resolvedNegativePrompt = negative_prompt ?? pixaiConfig.negativePrompts;
        const resolvedSamplingSteps = pixaiConfig.samplingSteps;
        const resolvedCfgScale = pixaiConfig.cfgScale;
        const resolvedModelStyle: CreateTaskParams["modelStyle"] = style_key
          ? { type: "key", keyId: style_key }
          : pixaiConfig.modelStyle;

        const taskParams: CreateTaskParams = {
          prompts: resolvedPrompt,
          modelId,
          negativePrompts: resolvedNegativePrompt,
          width: resolvedWidth,
          height: resolvedHeight,
          batchSize: resolvedBatchSize,
          samplingSteps: resolvedSamplingSteps,
          cfgScale: resolvedCfgScale,
          promptHelper: pixaiConfig.promptHelper,
          seed: seed ?? pixaiConfig.seed,
          priority: pixaiConfig.priority,
          clipSkip: pixaiConfig.clipSkip,
          lightning: pixaiConfig.lightning,
          modelStyle: resolvedModelStyle,
          inferenceProfile: pixaiConfig.inferenceProfile,
          samplingMethod: pixaiConfig.samplingMethod,
          qualityTag: pixaiConfig.qualityTag,
          isPrivate: pixaiConfig.isPrivate,
        };

        const taskCtx = {
          resolvedPrompt,
          resolvedWidth,
          resolvedHeight,
          resolvedBatchSize,
          resolvedNegativePrompt,
          resolvedSamplingSteps,
          resolvedCfgScale,
          resolvedModelStyle,
          startTime,
        };

        // --- No rate limiter: original flow ---
        if (!rateLimiter) {
          try {
            return await startTaskInBackground(taskParams, taskCtx);
          } catch (err) {
            return { error: String(err) };
          }
        }

        // --- Rate limiter flow ---
        const isAdmin = userId != null && adminIds?.includes(userId) === true;
        const result = rateLimiter.tryAcquire(chatId, userId, isAdmin);

        if (result.allowed) {
          try {
            return await startTaskInBackground(taskParams, taskCtx);
          } catch (err) {
            return { error: String(err) };
          }
        }

        // Not allowed — check reason
        switch (result.reason) {
          case "user_cooldown":
            return {
              error: "user_cooldown",
              message: `生图冷却中，请等待 ${result.cooldownSec} 秒`,
              cooldownSec: result.cooldownSec,
            };
          case "chat_cooldown":
            return {
              error: "chat_cooldown",
              message: `本群生图冷却中，请等待 ${result.cooldownSec} 秒`,
              cooldownSec: result.cooldownSec,
            };
          case "hourly_exceeded":
            return {
              error: "hourly_exceeded",
              message: `本小时生图次数已达上限 (${result.hourlyUsed}/${result.hourlyLimit})，请稍后再试`,
              used: result.hourlyUsed,
              limit: result.hourlyLimit,
            };
          case "concurrent_full": {
            // Try to enqueue
            const slot = rateLimiter.enqueue(chatId, userId, isAdmin);
            if (!slot) {
              return { error: "queue_full", message: "当前生图请求过多，请稍后再试" };
            }

            // Fire-and-forget: wait for slot then create task
            slot.promise
              .then(async () => {
                try {
                  await startTaskInBackground(taskParams, taskCtx);
                } catch (err) {
                  const errMsg = err instanceof Error ? err.message : String(err);
                  onLog?.({
                    level: "error",
                    message: `PixAI queued task failed: ${errMsg}`,
                    meta: { chatId },
                  });
                  api.sendMessage(chatId, `排队的图片生成失败: ${errMsg}`).catch(() => {});
                }
              })
              .catch((err) => {
                const errMsg = err instanceof Error ? err.message : String(err);
                onLog?.({
                  level: "warn",
                  message: `PixAI queue request rejected: ${errMsg}`,
                  meta: { chatId },
                });
              });

            return {
              status: "queued",
              message: `已排队，当前第 ${slot.position} 位`,
              position: slot.position,
            };
          }
          case "queue_full":
            return { error: "queue_full", message: "当前生图请求过多，请稍后再试" };
          default:
            return { error: "rate_limited", message: "生图请求被限流，请稍后再试" };
        }
      },
    }),
  };
}

// --- Shared helper: inject PixAI tool + permission control ---

export function injectPixAITool(
  allTools: Record<string, Tool>,
  options: {
    allowed: boolean;
    webToolsConfig?: WebToolsConfig;
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
  },
): void {
  const { allowed, webToolsConfig } = options;

  if (
    allowed &&
    webToolsConfig?.imageGeneration?.provider === "pixai" &&
    webToolsConfig.imageGeneration.apiKey
  ) {
    Object.assign(
      allTools,
      createPixAITool({
        config: webToolsConfig.imageGeneration,
        api: options.api,
        chatId: options.chatId,
        userId: options.userId,
        recentBotMessageIds: options.recentBotMessageIds,
        timeoutConfig: options.timeoutConfig,
        onLog: options.onLog,
        onGenerationTrack: options.onGenerationTrack,
        rateLimiter: options.rateLimiter,
        adminIds: options.adminIds,
        nsfwChecker: options.nsfwChecker,
      }),
    );
  } else {
    delete allTools.generate_image;
  }
}

// --- Background poll & send ---

export async function pollAndSend(
  client: PixAIClient,
  taskId: string,
  timeoutMs: number,
  ctx: {
    api: Api;
    chatId: number;
    recentBotMessageIds: number[];
    prompt: string;
    baseRecord: Omit<PixAIGenerationRecord, "status">;
    onLog?: (entry: BotLogEntry) => void | Promise<void>;
    onGenerationTrack?: (record: PixAIGenerationRecord) => void | Promise<void>;
    startTime: number;
    onDone?: () => void;
    nsfwChecker?: NsfwChecker;
  },
): Promise<void> {
  try {
    const { urls, mediaIds } = await client.pollUntilComplete(taskId, timeoutMs);
    const caption = ctx.prompt.length > 200 ? `${ctx.prompt.slice(0, 200)}...` : ctx.prompt;

    // NSFW detection: check images before sending
    let hasSpoiler = false;
    let nsfwScores: NsfwScores[] | undefined;
    if (ctx.nsfwChecker && urls.length > 0) {
      const nsfwResult = await ctx.nsfwChecker.checkImageUrls(urls);
      hasSpoiler = nsfwResult.isNsfw;
      nsfwScores = nsfwResult.scores;
      if (hasSpoiler) {
        ctx.onLog?.({
          level: "info",
          message: `NSFW detected for task ${taskId}, applying spoiler`,
          meta: { chatId: ctx.chatId, taskId },
        });
      }
    }

    if (urls.length === 1) {
      const sent = await ctx.api.sendPhoto(ctx.chatId, urls[0]!, {
        caption,
        has_spoiler: hasSpoiler,
      });
      ctx.recentBotMessageIds.push(sent.message_id);
    } else {
      // Multiple images: use sendMediaGroup
      const media = urls.map((url, i) => ({
        type: "photo" as const,
        media: url,
        has_spoiler: hasSpoiler,
        ...(i === 0 ? { caption } : {}),
      }));
      const sent = await ctx.api.sendMediaGroup(ctx.chatId, media);
      for (const msg of sent) {
        ctx.recentBotMessageIds.push(msg.message_id);
      }
    }

    // Track completed generation
    ctx.onGenerationTrack?.({
      ...ctx.baseRecord,
      status: "completed",
      mediaUrls: urls,
      mediaIds: mediaIds.length > 0 ? mediaIds : undefined,
      nsfwScores,
      durationMs: Date.now() - ctx.startTime,
    });

    ctx.onLog?.({
      level: "info",
      message: `PixAI task completed, sent ${urls.length} image(s)`,
      meta: { chatId: ctx.chatId, taskId, imageCount: urls.length },
    });
  } finally {
    ctx.onDone?.();
  }
}
