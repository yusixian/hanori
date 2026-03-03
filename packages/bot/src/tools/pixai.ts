import type {
  BotLogEntry,
  PixAIGenerationRecord,
  TimeoutConfig,
  WebToolsConfig,
} from "@cos-tool-bot/shared";
import { DEFAULT_TIMEOUT_CONFIG } from "@cos-tool-bot/shared";
import type { Tool } from "ai";
import { tool } from "ai";
import type { Api } from "grammy";
import { z } from "zod";
import { sleep } from "../utils/sleep.js";
import { zodToAiSchema } from "./utils.js";

/** Default model ID: Tsubaki v1.1 */
export const PIXAI_DEFAULT_MODEL_ID = "1935090615918113018";

// --- PixAI API types ---

interface PixAITaskResponse {
  id: string;
  status: string;
  outputs?: {
    mediaUrls?: Array<string | null>;
    mediaIds?: Array<string | null>;
  };
  error?: string;
}

// --- PixAI REST client ---

const PIXAI_BASE_URL = "https://api.pixai.art/v1";

class PixAIClient {
  constructor(private apiKey: string) {}

  async createTask(params: {
    prompts: string;
    modelId: string;
    negativePrompts?: string;
    width?: number;
    height?: number;
    batchSize?: number;
    samplingSteps?: number;
    cfgScale?: number;
    promptHelper?: boolean;
  }): Promise<PixAITaskResponse> {
    const body = {
      parameters: {
        prompts: params.prompts,
        modelId: params.modelId,
        negativePrompts: params.negativePrompts || "",
        width: params.width ?? 768,
        height: params.height ?? 1280,
        batchSize: params.batchSize ?? 1,
        samplingSteps: params.samplingSteps ?? 20,
        cfgScale: params.cfgScale ?? 5,
        promptHelper: params.promptHelper ? { enable: true } : undefined,
      },
    };

    const res = await fetch(`${PIXAI_BASE_URL}/task`, {
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

  async getTask(taskId: string): Promise<PixAITaskResponse> {
    const res = await fetch(`${PIXAI_BASE_URL}/task/${taskId}`, {
      headers: { Authorization: `Bearer ${this.apiKey}` },
    });

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`PixAI get task failed: HTTP ${res.status} ${text}`);
    }

    return (await res.json()) as PixAITaskResponse;
  }

  async pollUntilComplete(
    taskId: string,
    timeoutMs: number,
    intervalMs = 5000,
  ): Promise<{ urls: string[]; mediaIds: string[] }> {
    const deadline = Date.now() + timeoutMs;

    // Initial delay: image generation takes several seconds at minimum
    await sleep(intervalMs);

    while (Date.now() < deadline) {
      const task = await this.getTask(taskId);

      if (task.status === "failed" || task.status === "cancelled") {
        throw new Error(`PixAI task ${task.status}: ${task.error ?? "unknown error"}`);
      }

      if (task.status === "completed") {
        const mediaIds = (task.outputs?.mediaIds ?? []).filter(
          (id): id is string => id != null && id !== "",
        );

        // Filter out null values from mediaUrls
        const urls = (task.outputs?.mediaUrls ?? []).filter(
          (u): u is string => u != null && u !== "",
        );
        if (urls.length > 0) return { urls, mediaIds };

        // Fallback: use mediaIds to construct image URLs
        if (mediaIds.length > 0) {
          return {
            urls: mediaIds.map((id) => `${PIXAI_BASE_URL}/media/${id}/image`),
            mediaIds,
          };
        }

        throw new Error("PixAI task completed but no images returned");
      }

      // Still waiting/running — sleep then retry
      await sleep(intervalMs);
    }

    throw new Error(`PixAI task timed out after ${timeoutMs / 1000}s`);
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
  } = options;
  const pixaiConfig = config.pixaiConfig ?? {};
  const client = new PixAIClient(config.apiKey!);
  const modelId = config.model || PIXAI_DEFAULT_MODEL_ID;

  return {
    generate_image: tool({
      description:
        "使用 PixAI 生成高质量 AI 图片。图片会在后台生成完成后自动发送到聊天，无需调用 send_photo。",
      inputSchema: zodToAiSchema(
        z.object({
          prompt: z.string().max(4096).describe("图片描述/提示词（建议英文）"),
          negative_prompt: z.string().max(4096).optional().describe("负面提示词"),
          width: z.number().int().min(512).max(1280).optional().describe("图片宽度 (512-1280)"),
          height: z.number().int().min(512).max(1280).optional().describe("图片高度 (512-1280)"),
          batch_size: z.number().int().min(1).max(4).optional().describe("生成数量 (1-4)"),
        }),
      ),
      execute: async ({ prompt, negative_prompt, width, height, batch_size }) => {
        const startTime = Date.now();
        const resolvedWidth = width ?? pixaiConfig.width ?? 768;
        const resolvedHeight = height ?? pixaiConfig.height ?? 1280;
        const resolvedBatchSize = batch_size ?? pixaiConfig.batchSize ?? 1;
        const resolvedNegativePrompt = negative_prompt ?? pixaiConfig.negativePrompts;
        const resolvedSamplingSteps = pixaiConfig.samplingSteps ?? 20;
        const resolvedCfgScale = pixaiConfig.cfgScale ?? 5;

        try {
          const task = await client.createTask({
            prompts: prompt,
            modelId,
            negativePrompts: resolvedNegativePrompt,
            width: resolvedWidth,
            height: resolvedHeight,
            batchSize: resolvedBatchSize,
            samplingSteps: resolvedSamplingSteps,
            cfgScale: resolvedCfgScale,
            promptHelper: pixaiConfig.promptHelper,
          });

          // Shared base fields for all generation tracking calls
          const baseRecord: Omit<PixAIGenerationRecord, "status"> = {
            chatId,
            userId,
            taskId: task.id,
            prompt,
            negativePrompt: resolvedNegativePrompt,
            modelId,
            width: resolvedWidth,
            height: resolvedHeight,
            batchSize: resolvedBatchSize,
            samplingSteps: resolvedSamplingSteps,
            cfgScale: resolvedCfgScale,
            promptHelper: !!pixaiConfig.promptHelper,
          };

          onLog?.({
            level: "info",
            message: `PixAI task created: ${task.id}`,
            meta: { chatId, taskId: task.id, prompt: prompt.slice(0, 200) },
          });

          onGenerationTrack?.({ ...baseRecord, status: "pending" });

          // Fire-and-forget: poll and send in background
          const taskTimeoutMs = timeoutConfig?.pixaiTaskMs ?? DEFAULT_TIMEOUT_CONFIG.pixaiTaskMs;
          pollAndSend(client, task.id, taskTimeoutMs, {
            api,
            chatId,
            recentBotMessageIds,
            prompt,
            baseRecord,
            onLog,
            onGenerationTrack,
            startTime,
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
              durationMs: Date.now() - startTime,
            });
            api.sendMessage(chatId, `图片生成失败: ${errMsg}`).catch(() => {});
          });

          return {
            taskId: task.id,
            status: "started",
            message: "图片正在后台生成，完成后会自动发送到聊天",
          };
        } catch (err) {
          return { error: String(err) };
        }
      },
    }),
  };
}

// --- Background poll & send ---

async function pollAndSend(
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
  },
): Promise<void> {
  const { urls, mediaIds } = await client.pollUntilComplete(taskId, timeoutMs);
  const caption = ctx.prompt.length > 200 ? `${ctx.prompt.slice(0, 200)}...` : ctx.prompt;

  if (urls.length === 1) {
    const sent = await ctx.api.sendPhoto(ctx.chatId, urls[0]!, { caption });
    ctx.recentBotMessageIds.push(sent.message_id);
  } else {
    // Multiple images: use sendMediaGroup
    const media = urls.map((url, i) => ({
      type: "photo" as const,
      media: url,
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
    durationMs: Date.now() - ctx.startTime,
  });

  ctx.onLog?.({
    level: "info",
    message: `PixAI task completed, sent ${urls.length} image(s)`,
    meta: { chatId: ctx.chatId, taskId, imageCount: urls.length },
  });
}
