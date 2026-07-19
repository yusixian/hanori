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
import { AVAILABLE_STYLES } from "./pixai-styles.js";
import { sleep } from "../utils/sleep.js";
import { zodToAiSchema } from "./utils.js";

/** Default model ID: Tsubaki v1.1 */
export const PIXAI_DEFAULT_MODEL_ID = "1935090615918113018";

// --- PixAI API endpoints ---

const PIXAI_REST_URL = "https://api.pixai.art/v1";
const GRAPHQL_ENDPOINT = "https://api.pixai.art/graphql";
const PIXAI_REQUEST_TIMEOUT_MS = 30_000;

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

export type PixAITaskTerminalStatus = "failed" | "cancelled" | "timeout";

export class PixAITaskTerminalError extends Error {
  readonly pixaiErrorKind = "task-terminal" as const;

  constructor(
    readonly status: PixAITaskTerminalStatus,
    message: string,
  ) {
    super(message);
    this.name = "PixAITaskTerminalError";
  }
}

export type PixAIRecoveryTerminalReason =
  | "task-not-found"
  | "empty-task-response"
  | "completed-without-images";

export class PixAIRecoveryTerminalError extends Error {
  readonly pixaiErrorKind = "recovery-terminal" as const;

  constructor(
    readonly reason: PixAIRecoveryTerminalReason,
    message: string,
  ) {
    super(message);
    this.name = "PixAIRecoveryTerminalError";
  }
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
    private requestTimeoutMs = PIXAI_REQUEST_TIMEOUT_MS,
  ) {}

  async createTask(params: CreateTaskParams): Promise<PixAITaskResponse> {
    if (this.apiMode === "graphql") {
      return this.createTaskGraphQL(params);
    }
    return this.createTaskREST(params);
  }

  async getTask(taskId: string, signal?: AbortSignal): Promise<PixAITaskResponse> {
    if (this.apiMode === "graphql") {
      return this.getTaskGraphQL(taskId, signal);
    }
    return this.getTaskREST(taskId, signal);
  }

  async pollUntilComplete(
    taskId: string,
    timeoutMs: number,
    intervalMs = 5000,
    initialDelayMs = intervalMs,
    signal?: AbortSignal,
  ): Promise<TaskPollResult> {
    const deadline = Date.now() + Math.max(0, timeoutMs);

    // Initial delay: image generation takes several seconds at minimum
    await sleepWithSignal(initialDelayMs, signal);

    do {
      signal?.throwIfAborted();
      const task = await this.getTask(taskId, signal);

      if (task.status === "failed" || task.status === "cancelled") {
        throw new PixAITaskTerminalError(
          task.status,
          `PixAI task ${task.status}: ${task.error ?? "unknown error"}`,
        );
      }

      if (task.status === "completed") {
        return this.extractImagesFromTask(task);
      }

      const remainingMs = deadline - Date.now();
      if (remainingMs <= 0) break;

      // Still waiting/running — sleep then retry
      await sleepWithSignal(Math.min(intervalMs, remainingMs), signal);
    } while (Date.now() < deadline);

    throw new PixAITaskTerminalError("timeout", `PixAI task timed out after ${timeoutMs / 1000}s`);
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
      signal: AbortSignal.timeout(this.requestTimeoutMs),
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

  private async getTaskGraphQL(taskId: string, signal?: AbortSignal): Promise<PixAITaskResponse> {
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
      signal: requestSignal(this.requestTimeoutMs, signal),
    });

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      if (res.status === 404) {
        throw new PixAIRecoveryTerminalError(
          "task-not-found",
          `PixAI GraphQL get task failed: HTTP ${res.status} ${text}`,
        );
      }
      throw new Error(`PixAI GraphQL get task failed: HTTP ${res.status} ${text}`);
    }

    const json = (await res.json()) as GraphQLResponse<{ task: PixAITaskResponse }>;

    if (json.errors?.length) {
      throw new Error(`PixAI GraphQL error: ${json.errors.map((e) => e.message).join(", ")}`);
    }

    if (!json.data?.task) {
      throw new PixAIRecoveryTerminalError(
        "empty-task-response",
        "PixAI GraphQL get task: unexpected empty response",
      );
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
      signal: AbortSignal.timeout(this.requestTimeoutMs),
    });

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`PixAI create task failed: HTTP ${res.status} ${text}`);
    }

    return (await res.json()) as PixAITaskResponse;
  }

  private async getTaskREST(taskId: string, signal?: AbortSignal): Promise<PixAITaskResponse> {
    const res = await fetch(`${PIXAI_REST_URL}/task/${taskId}`, {
      headers: { Authorization: `Bearer ${this.apiKey}` },
      signal: requestSignal(this.requestTimeoutMs, signal),
    });

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      if (res.status === 404) {
        throw new PixAIRecoveryTerminalError(
          "task-not-found",
          `PixAI get task failed: HTTP ${res.status} ${text}`,
        );
      }
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

    throw new PixAIRecoveryTerminalError(
      "completed-without-images",
      "PixAI task completed but no images returned",
    );
  }
}

function requestSignal(timeoutMs: number, signal?: AbortSignal): AbortSignal {
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  return signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
}

function sleepWithSignal(ms: number, signal?: AbortSignal): Promise<void> {
  if (!signal) return sleep(ms);
  if (signal.aborted) return Promise.reject(signal.reason);

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

export class PixAIGenerationPersistenceError extends Error {
  constructor(taskId: string, cause: unknown) {
    super(`Failed to persist completed PixAI task ${taskId}`, { cause });
    this.name = "PixAIGenerationPersistenceError";
  }
}

export async function trackPendingGeneration(
  record: PixAIGenerationRecord,
  onGenerationTrack?: (record: PixAIGenerationRecord) => void | Promise<void>,
  onLog?: (entry: BotLogEntry) => void | Promise<void>,
): Promise<void> {
  try {
    await onGenerationTrack?.(record);
  } catch (err) {
    try {
      await onLog?.({
        level: "error",
        message: `Failed to persist pending PixAI task: ${err instanceof Error ? err.message : String(err)}`,
        meta: { chatId: record.chatId, taskId: record.taskId },
      });
    } catch {
      // Logging must not abandon a task that was already created remotely.
    }
  }
}

export function isTerminalPixAITaskError(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const candidate = error as { pixaiErrorKind?: unknown; status?: unknown };
  return (
    candidate.pixaiErrorKind === "task-terminal" &&
    (candidate.status === "failed" ||
      candidate.status === "cancelled" ||
      candidate.status === "timeout")
  );
}

export function isTerminalPixAIRecoveryError(error: unknown): boolean {
  if (isTerminalPixAITaskError(error)) return true;
  if (typeof error !== "object" || error === null) return false;
  const candidate = error as { pixaiErrorKind?: unknown; reason?: unknown };
  return (
    candidate.pixaiErrorKind === "recovery-terminal" &&
    (candidate.reason === "task-not-found" ||
      candidate.reason === "empty-task-response" ||
      candidate.reason === "completed-without-images")
  );
}

interface PixAIBackgroundFailureOptions {
  api: Api;
  chatId: number;
  baseRecord: Omit<PixAIGenerationRecord, "status">;
  startTime: number;
  logPrefix: string;
  onLog?: (entry: BotLogEntry) => void | Promise<void>;
  onGenerationTrack?: (record: PixAIGenerationRecord) => void | Promise<void>;
}

async function logBackgroundFailure(
  options: PixAIBackgroundFailureOptions,
  level: BotLogEntry["level"],
  message: string,
): Promise<void> {
  try {
    await options.onLog?.({
      level,
      message,
      meta: { chatId: options.chatId, taskId: options.baseRecord.taskId },
    });
  } catch {
    // Failure handling must not create an unhandled rejection when logging is unavailable.
  }
}

export async function handlePixAIBackgroundFailure(
  error: unknown,
  options: PixAIBackgroundFailureOptions,
): Promise<void> {
  const errorMessage = error instanceof Error ? error.message : String(error);

  if (error instanceof PixAIGenerationPersistenceError) {
    await logBackgroundFailure(options, "error", errorMessage);
    return;
  }

  if (!isTerminalPixAITaskError(error)) {
    await logBackgroundFailure(
      options,
      "warn",
      `${options.logPrefix} hit a retryable error; leaving task pending for recovery: ${errorMessage}`,
    );
    return;
  }

  await logBackgroundFailure(options, "error", `${options.logPrefix} failed: ${errorMessage}`);

  try {
    await options.onGenerationTrack?.({
      ...options.baseRecord,
      status: "failed",
      errorMessage,
      durationMs: Date.now() - options.startTime,
    });
  } catch (trackError) {
    await logBackgroundFailure(
      options,
      "error",
      `Failed to persist PixAI failure: ${trackError instanceof Error ? trackError.message : String(trackError)}`,
    );
    return;
  }

  try {
    await options.api.sendMessage(options.chatId, `图片生成失败: ${errorMessage}`);
  } catch (sendError) {
    await logBackgroundFailure(
      options,
      "warn",
      `Failed to notify user about PixAI error: ${sendError instanceof Error ? sendError.message : String(sendError)}`,
    );
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
    return client.createTask(resolvedParams).then(async (task) => {
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

      rateLimiter?.registerTask(task.id, chatId, userId);

      await trackPendingGeneration({ ...baseRecord, status: "pending" }, onGenerationTrack, onLog);

      const taskTimeoutMs = timeoutConfig?.pixaiTaskMs ?? DEFAULT_TIMEOUT_CONFIG.pixaiTaskMs;
      void pollAndSend(client, task.id, taskTimeoutMs, {
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
      }).catch((error) =>
        handlePixAIBackgroundFailure(error, {
          api,
          chatId,
          baseRecord,
          startTime: ctx.startTime,
          logPrefix: "PixAI background task",
          onLog,
          onGenerationTrack,
        }),
      );

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
              "可选风格 key，根据画面需要选择最合适的风格。可选值: " +
                AVAILABLE_STYLES.map(
                  (s) => `${s.key}(${s.label}${s.hint ? `，${s.hint}` : ""})`,
                ).join(" / "),
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
    signal?: AbortSignal;
  },
  initialDelayMs = 5000,
): Promise<void> {
  try {
    const { urls, mediaIds } = await client.pollUntilComplete(
      taskId,
      timeoutMs,
      5000,
      initialDelayMs,
      ctx.signal,
    );
    ctx.signal?.throwIfAborted();
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

    ctx.signal?.throwIfAborted();

    try {
      await ctx.onGenerationTrack?.({
        ...ctx.baseRecord,
        status: "completed",
        mediaUrls: urls,
        mediaIds: mediaIds.length > 0 ? mediaIds : undefined,
        nsfwScores,
        durationMs: Date.now() - ctx.startTime,
      });
    } catch (err) {
      throw new PixAIGenerationPersistenceError(taskId, err);
    }

    try {
      if (urls.length === 1) {
        const sent = await ctx.api.sendPhoto(ctx.chatId, urls[0]!, {
          caption,
          has_spoiler: hasSpoiler,
        });
        ctx.recentBotMessageIds.push(sent.message_id);
      } else {
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
    } catch (err) {
      try {
        await ctx.onLog?.({
          level: "error",
          message: `PixAI task completed but Telegram delivery failed: ${err instanceof Error ? err.message : String(err)}`,
          meta: { chatId: ctx.chatId, taskId, imageCount: urls.length },
        });
      } catch {
        // Delivery failure must not overwrite the completed generation state.
      }
      return;
    }

    ctx.onLog?.({
      level: "info",
      message: `PixAI task completed, sent ${urls.length} image(s)`,
      meta: { chatId: ctx.chatId, taskId, imageCount: urls.length },
    });
  } finally {
    ctx.onDone?.();
  }
}

export interface RecoverPixAIGenerationOptions {
  apiKey: string;
  api: Api;
  record: PixAIGenerationRecord;
  timeoutMs: number;
  createdAtMs: number;
  onLog?: (entry: BotLogEntry) => void | Promise<void>;
  onGenerationTrack?: (record: PixAIGenerationRecord) => void | Promise<void>;
  nsfwChecker?: NsfwChecker;
  signal?: AbortSignal;
}

export async function recoverPixAIGeneration(
  options: RecoverPixAIGenerationOptions,
): Promise<void> {
  const { record } = options;
  const client = new PixAIClient(options.apiKey, record.pixaiConfig?.apiMode ?? "graphql");
  const startTime = Math.max(options.createdAtMs, Date.now() - 2_147_483_647);
  const remainingTimeoutMs = Math.max(0, options.createdAtMs + options.timeoutMs - Date.now());

  await options.onLog?.({
    level: "info",
    message: `Recovering PixAI task: ${record.taskId}`,
    meta: { chatId: record.chatId, taskId: record.taskId },
  });

  await pollAndSend(
    client,
    record.taskId,
    remainingTimeoutMs,
    {
      api: options.api,
      chatId: record.chatId,
      recentBotMessageIds: [],
      prompt: record.prompt,
      baseRecord: {
        chatId: record.chatId,
        userId: record.userId,
        taskId: record.taskId,
        prompt: record.prompt,
        negativePrompt: record.negativePrompt,
        modelId: record.modelId,
        width: record.width,
        height: record.height,
        batchSize: record.batchSize,
        samplingSteps: record.samplingSteps,
        cfgScale: record.cfgScale,
        promptHelper: record.promptHelper,
        pixaiConfig: record.pixaiConfig,
      },
      onLog: options.onLog,
      onGenerationTrack: options.onGenerationTrack,
      startTime,
      nsfwChecker: options.nsfwChecker,
      signal: options.signal,
    },
    0,
  );
}
