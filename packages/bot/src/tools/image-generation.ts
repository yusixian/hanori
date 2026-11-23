import { IMAGE_DYNAMIC_PARAMETER_PATTERNS } from "@cos-tool-bot/shared";
import type {
  GenerationMaterialSelection,
  ImageGenerationActor,
  ImageGenerationPort,
  ImagePurpose,
  ImageProviderRoute,
} from "@cos-tool-bot/shared";
import type { Tool } from "ai";
import { tool } from "ai";
import type { Api } from "grammy";
import { z } from "zod";
import { zodToAiSchema } from "./utils.js";
import {
  awaitsImageConfirmation,
  sendImageConfirmationMessage,
} from "../handlers/image-confirmation.js";

const imageDynamicParametersSchema = z
  .object({
    model: z.string().trim().min(1).max(100).optional(),
    size: z.string().regex(IMAGE_DYNAMIC_PARAMETER_PATTERNS.size).optional(),
    quality: z.enum(["auto", "low", "medium", "high"]).optional(),
    aspectRatio: z.string().regex(IMAGE_DYNAMIC_PARAMETER_PATTERNS.aspectRatio).optional(),
    imageSize: z.string().regex(IMAGE_DYNAMIC_PARAMETER_PATTERNS.imageSize).optional(),
  })
  .strict();

export interface ImageGenerationToolOptions {
  port: ImageGenerationPort;
  getActor: () => ImageGenerationActor;
  description?: string;
  replyMessageId?: number;
  api?: Api;
}

export async function createImageGenerationTools({
  port,
  getActor,
  description,
  replyMessageId,
  api,
}: ImageGenerationToolOptions): Promise<Record<string, Tool>> {
  const tools: Record<string, Tool> = {
    get_image_generation: tool({
      description:
        "查询当前用户有权查看的图片任务。分别报告生成状态、deliveryState 和取消结果；只有 delivered 且有 Telegram message IDs 才表示已交付，unknown 不可自动重发。",
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

  if (port.retryDelivery) {
    tools.retry_image_delivery = tool({
      description:
        "仅在已生成且确定未发送（deliveryState=failed）时重试原图片投递；不重新生图。unknown、正在投递及已交付任务禁止重发。",
      inputSchema: zodToAiSchema(z.object({ generationId: z.string().min(1).max(128) })),
      execute: async ({ generationId }) => port.retryDelivery!(getActor(), generationId),
    });
  }

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
          "加载 Skill、列预设和准备提示词不等于提交。accepted 仅表示本地已接收请求；排队、待审批和生成中都不能声称已交付。只有真实 Telegram 回执才表示已交付。",
          "只能从当前可用路由中选择；未列出的路由不可用。不要在失败后自动切换供应商。",
          "只有 anime_illustration 可用时，生图请求使用该路由；不要因照片或写实风格选择未启用的后端。",
          "用户要求画指定虚构角色或作品角色时，不得自动绑定请求者本人或其默认代表形象。personTelegramId 仅在本次明确要求本人/某位群友时填写；“帮我画”“给我画”只表示请求者，不表示画本人。",
          "用户明确指定已保存角色、群友形象或提示词资产时，通过 materials 传递已检索确认的 id；不要把群友身份或 NSFW 模式当作模型可自行推断的默认值。",
          "服务端会重新校验 Bot 隔离、角色可见性、安全设置和 pinned 注入；明确选择的素材优先，冲突的 pinned 资产应通过 excludedAssetIds 排除。",
          ...routes.map(
            (route) =>
              `${route.purpose}: ${route.label}。${route.useWhen}。默认供应商 ${route.defaultBackendId ?? route.provider}；可用供应商 ${(route.availableBackends ?? [route.provider]).join(", ")}`,
          ),
          ...routes.flatMap((route) =>
            (route.backendCapabilities ?? []).map(
              (capabilities) =>
                `${route.purpose}/${capabilities.backendId}: 预设${capabilities.presetsRequired ? "必选" : "可选"}；动态参数 ${(capabilities.dynamicParameters ?? []).join(", ")}；连接默认值和供应商参数说明 ${JSON.stringify(capabilities.connection ?? {})}`,
            ),
          ),
        ].join("\n"),
        inputSchema: zodToAiSchema(
          z.object({
            purpose: purposeSchema,
            backendId: z
              .enum(["mcp_pixai", "mcp_openai", "mcp_gemini", "general_backend"])
              .optional()
              .describe(
                "用户明确指定 PixAI/GPT/Gemini 时分别选 mcp_pixai/mcp_openai/mcp_gemini；省略使用该用途的默认供应商。只能选择路由列出的 availableBackends。",
              ),
            routingIntent: z
              .enum(["explicit", "semantic"])
              .default("semantic")
              .describe(
                "只有用户明确要求通用图片后端时才使用 explicit；模型自行判断时使用 semantic",
              ),
            prompt: z.string().min(1).max(8_000).describe("图片提示词"),
            parameters: imageDynamicParametersSchema
              .optional()
              .describe(
                "GPT/Gemini 可动态指定模型、尺寸和质量，或 Gemini 的 aspectRatio/imageSize；省略走连接默认值，不必选择预设。以路由的 backendCapabilities 参数说明为准。PixAI/legacy 后端不支持此字段。",
              ),
            presetKey: z.string().min(1).max(128).optional().describe("已列出的预设 key"),
            negativePrompt: z
              .string()
              .max(4_000)
              .optional()
              .describe("可选负面提示词；普通成员使用后可能需要管理员批准"),
            seed: z.number().int().min(0).max(4_294_967_295).optional().describe("可选随机种子"),
            materials: z
              .object({
                characterIds: z.array(z.number().int().positive()).max(20).optional(),
                personTelegramId: z
                  .number()
                  .int()
                  .positive()
                  .optional()
                  .describe("仅当用户明确要求画某位群友/本人时填写，不能由模型自行推断"),
                assetIds: z.array(z.number().int().positive()).max(20).optional(),
                excludedAssetIds: z.array(z.number().int().positive()).max(100).optional(),
                skipPinned: z.boolean().optional().describe("本次明确不使用默认 pinned 资产"),
                skipDefaultOutfit: z
                  .boolean()
                  .optional()
                  .describe("用户明确指定新服装且不希望叠加角色默认服装时使用"),
                safetyMode: z
                  .enum(["safe", "nsfw"])
                  .optional()
                  .describe("只有用户本次明确要求 NSFW 时才能填写 nsfw；模型不得自行升级"),
                skipLibrary: z
                  .boolean()
                  .optional()
                  .describe("用户明确要求绕过资产库，或库不可用后用户明确同意重试时使用"),
              })
              .optional()
              .describe("角色与提示词资产选择；服务端会按当前 Bot、权限和安全设置重新校验"),
          }),
        ),
        execute: async (
          {
            purpose,
            backendId,
            routingIntent,
            prompt,
            presetKey,
            parameters,
            negativePrompt,
            seed,
            materials,
          },
          executionOptions,
        ) =>
          (async () => {
            const result = await port.create(getActor(), {
              ...(executionOptions.toolCallId ? { toolCallId: executionOptions.toolCallId } : {}),
              purpose: purpose as ImagePurpose,
              ...(backendId ? { backendId: backendId as ImageProviderRoute } : {}),
              routingIntent,
              prompt,
              ...(materials ? { materials: materials as GenerationMaterialSelection } : {}),
              ...(presetKey ? { presetKey } : {}),
              ...(parameters ? { parameters } : {}),
              ...(negativePrompt ? { negativePrompt } : {}),
              ...(seed !== undefined ? { seed } : {}),
            });
            if (result.accepted && awaitsImageConfirmation(result.generation)) {
              if (!api) return { pending_confirmation: true, generation_id: result.generation.id };
              try {
                const confirmationMessageId = await sendImageConfirmationMessage(
                  api,
                  getActor().chatId,
                  result.generation,
                  getActor().requestContext?.threadId,
                );
                const recorded = await port.recordConfirmationMessage?.(
                  getActor(),
                  result.generation.id,
                  confirmationMessageId,
                );
                if (recorded === false) throw new Error("image_confirmation_record_failed");
              } catch (error) {
                await port.cancelConfirmation?.(getActor(), result.generation.id).catch(() => {});
                throw error;
              }
              return {
                pending_confirmation: true,
                generation_id: result.generation.id,
                message: "已发送生图确认卡，确认后才会提交任务。",
              };
            }
            return result;
          })(),
      }),
      list_image_presets: tool({
        description:
          "列出当前用户在当前会话可用的图片预设。PixAI 创建前优先调用；GPT/Gemini 预设可选。",
        inputSchema: zodToAiSchema(
          z.object({
            purpose: purposeSchema.optional(),
            backendId: z
              .enum(["mcp_pixai", "mcp_openai", "mcp_gemini", "general_backend"])
              .optional(),
          }),
        ),
        execute: async ({ purpose, backendId }) => ({
          presets: await port.listPresets(
            getActor(),
            purpose as ImagePurpose | undefined,
            backendId as ImageProviderRoute | undefined,
          ),
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
