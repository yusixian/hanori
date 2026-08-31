import type { ImageGenerationActor, ImageGenerationPort, ImagePurpose } from "@cos-tool-bot/shared";
import type { Tool } from "ai";
import { tool } from "ai";
import { z } from "zod";
import { zodToAiSchema } from "./utils.js";

export interface ImageGenerationToolOptions {
  port: ImageGenerationPort;
  getActor: () => ImageGenerationActor;
  description?: string;
}

const purposeSchema = z
  .enum(["anime_illustration", "general_image"])
  .describe(
    "图片用途。anime_illustration 用于动漫、漫画、角色与插画且为默认；general_image 仅用于明确的通用图片需求。",
  );

export function createImageGenerationTools({
  port,
  getActor,
  description,
}: ImageGenerationToolOptions): Record<string, Tool> {
  return {
    create_image: tool({
      description:
        description ??
        "创建一项异步图片生成。含糊请求选择 anime_illustration；不要在失败后自动切换供应商。返回 generation id 后，Bot 会在后台恢复并投递结果。",
      inputSchema: zodToAiSchema(
        z.object({
          purpose: purposeSchema,
          routingIntent: z
            .enum(["explicit", "semantic"])
            .default("semantic")
            .describe("只有用户明确要求通用图片后端时才使用 explicit；模型自行判断时使用 semantic"),
          prompt: z.string().min(1).max(8_000).describe("图片提示词"),
          presetKey: z.string().min(1).max(128).optional().describe("已列出的预设 key"),
          negativePrompt: z
            .string()
            .max(4_000)
            .optional()
            .describe("可选负面提示词；普通成员使用后可能需要管理员批准"),
          seed: z.number().int().min(0).max(4_294_967_295).optional().describe("可选随机种子"),
        }),
      ),
      execute: async ({ purpose, routingIntent, prompt, presetKey, negativePrompt, seed }) =>
        port.create(getActor(), {
          purpose: purpose as ImagePurpose,
          routingIntent,
          prompt,
          ...(presetKey ? { presetKey } : {}),
          ...(negativePrompt ? { negativePrompt } : {}),
          ...(seed !== undefined ? { seed } : {}),
        }),
    }),
    list_image_presets: tool({
      description: "列出当前用户在当前会话可用的图片预设。创建图片前优先调用。",
      inputSchema: zodToAiSchema(z.object({ purpose: purposeSchema.optional() })),
      execute: async ({ purpose }) => ({
        presets: await port.listPresets(getActor(), purpose as ImagePurpose | undefined),
      }),
    }),
    get_image_generation: tool({
      description: "查询当前用户有权查看的图片生成任务状态。",
      inputSchema: zodToAiSchema(
        z.object({ generationId: z.string().min(1).max(128).describe("图片生成任务 id") }),
      ),
      execute: async ({ generationId }) => {
        const generation = await port.get(getActor(), generationId);
        return generation ? { found: true, generation } : { found: false };
      },
    }),
    cancel_image_generation: tool({
      description:
        "请求取消当前用户有权操作的图片生成。供应商接受取消请求不等于已经取消，只有状态变为 cancelled 才表示确认取消。",
      inputSchema: zodToAiSchema(
        z.object({ generationId: z.string().min(1).max(128).describe("图片生成任务 id") }),
      ),
      execute: async ({ generationId }) => port.cancel(getActor(), generationId),
    }),
  };
}
