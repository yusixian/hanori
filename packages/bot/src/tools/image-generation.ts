import type { ImageGenerationActor, ImageGenerationPort, ImagePurpose } from "@cos-tool-bot/shared";
import type { Tool } from "ai";
import { tool } from "ai";
import { z } from "zod";
import { zodToAiSchema } from "./utils.js";

export interface ImageGenerationToolOptions {
  port: ImageGenerationPort;
  getActor: () => ImageGenerationActor;
  description?: string;
  replyMessageId?: number;
}

export async function createImageGenerationTools({
  port,
  getActor,
  description,
  replyMessageId,
}: ImageGenerationToolOptions): Promise<Record<string, Tool>> {
  const tools: Record<string, Tool> = {
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

  const routes = (await port.listRoutes(getActor(), { includePresets: false })).filter(
    (route) => route.enabled,
  );
  const purposes = routes.map((route) => route.purpose);
  if (purposes.length > 0) {
    const purposeSchema = z.enum(purposes).describe("只能选择当前已启用的图片用途；以此枚举为准。");
    Object.assign(tools, {
      create_image: tool({
        description: [
          description ?? "创建一项异步图片生成，Bot 会在后台恢复并投递结果。",
          "只能从当前可用路由中选择；未列出的路由不可用。不要在失败后自动切换供应商。",
          "只有 anime_illustration 可用时，生图请求使用该路由；不要因照片或写实风格选择未启用的后端。",
          ...routes.map((route) => `${route.purpose}: ${route.label}。${route.useWhen}`),
        ].join("\n"),
        inputSchema: zodToAiSchema(
          z.object({
            purpose: purposeSchema,
            routingIntent: z
              .enum(["explicit", "semantic"])
              .default("semantic")
              .describe(
                "只有用户明确要求通用图片后端时才使用 explicit；模型自行判断时使用 semantic",
              ),
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
    });
  }

  if (replyMessageId !== undefined) {
    tools.inspect_replied_image_generation = tool({
      description:
        "读取当前回复图片的完整生成上下文，包括原始提示词、负面提示词、seed、preset、MCP operation 与供应商解析后的请求细节。分析图片或提示词问题时优先调用；同一聊天内所有用户均可查看。",
      inputSchema: zodToAiSchema(z.object({})),
      execute: async () => {
        const generation = await port.findByDeliveryMessage(getActor(), replyMessageId);
        return generation ? { found: true, generation } : { found: false };
      },
    });
  }

  return tools;
}
