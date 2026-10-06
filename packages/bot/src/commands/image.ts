import type {
  ImageGenerationView,
  ImagePreset,
  ImagePurpose,
  ImageDeliveryRetryResult,
} from "@cos-tool-bot/shared";
import type { CommandMiddleware } from "grammy";
import type { WrapperContext } from "../context.js";

export interface ImageCommandConfig {
  retryDelivery?: (input: {
    chatId: number;
    userId: number;
    chatType: "private" | "group" | "supergroup";
    generationId: string;
  }) => Promise<ImageDeliveryRetryResult>;
  listPresets(input: {
    chatId: number;
    userId: number;
    chatType: "private" | "group" | "supergroup";
    purpose?: ImagePurpose;
  }): Promise<ImagePreset[]>;
  getGeneration(input: {
    chatId: number;
    userId: number;
    chatType: "private" | "group" | "supergroup";
    generationId: string;
  }): Promise<ImageGenerationView | null>;
  cancelGeneration(input: {
    chatId: number;
    userId: number;
    chatType: "private" | "group" | "supergroup";
    generationId: string;
  }): Promise<{ ok: boolean; generation?: ImageGenerationView; message?: string }>;
}

const USAGE = [
  "用法:",
  "/image presets [anime_illustration|general_image] — 查看可用预设",
  "/image status <任务 ID> — 查看任务",
  "/image cancel <任务 ID> — 请求取消任务",
  "/image retry <任务 ID> — 仅重试确定未发送的原图片",
].join("\n");

function formatGeneration(generation: ImageGenerationView): string {
  const lines = [
    `任务: ${generation.id}`,
    `用途: ${generation.purpose}`,
    `供应商: ${generation.provider}`,
    `状态: ${generation.state}`,
  ];
  if (generation.deliveryTarget)
    lines.push(
      `目标聊天: ${generation.deliveryTarget.chatId}${generation.deliveryTarget.threadId === undefined ? "" : ` / topic ${generation.deliveryTarget.threadId}`}`,
    );
  if (generation.deliveryState) lines.push(`投递: ${generation.deliveryState}`);
  if (generation.cancellationState) lines.push(`取消: ${generation.cancellationState}`);
  if (generation.deliveryMessageIds?.length)
    lines.push(`Telegram 回执: ${generation.deliveryMessageIds.join(", ")}`);
  if (generation.deliveryErrorCode) lines.push(`投递错误: ${generation.deliveryErrorCode}`);
  if (generation.deliveryState === "unknown")
    lines.push("投递结果未知，禁止自动重发；请先核对原聊天中的图片和回执。");
  if (generation.presetKey) lines.push(`预设: ${generation.presetKey}`);
  if (generation.providerState) lines.push(`上游状态: ${generation.providerState}`);
  if (generation.message) lines.push(`说明: ${generation.message}`);
  if (generation.state === "cancel_requested") {
    lines.push("取消请求已提交，但只有状态变为 cancelled 才表示上游确认取消。");
  }
  return lines.join("\n");
}

export function createImageCommand(cfg: ImageCommandConfig): CommandMiddleware<WrapperContext> {
  return async (ctx) => {
    const chatId = ctx.chat?.id;
    const userId = ctx.from?.id;
    const chatType = ctx.chat?.type;
    if (
      chatId === undefined ||
      userId === undefined ||
      (chatType !== "private" && chatType !== "group" && chatType !== "supergroup")
    ) {
      return;
    }

    const [action = "", value] = String(ctx.match ?? "")
      .trim()
      .split(/\s+/, 2);
    if (action === "presets") {
      const purpose =
        value === "anime_illustration" || value === "general_image" ? value : undefined;
      if (value && !purpose) {
        await ctx.reply(USAGE);
        return;
      }
      const presets = await cfg.listPresets({ chatId, userId, chatType, purpose });
      if (presets.length === 0) {
        await ctx.reply("当前没有可用的生图预设。");
        return;
      }
      await ctx.reply(
        presets
          .map(
            (preset) =>
              `• ${preset.key} — ${preset.label}${preset.autoApproved ? "（自动批准）" : "（需管理员批准）"}`,
          )
          .join("\n"),
      );
      return;
    }

    if (action === "status" && value) {
      const generation = await cfg.getGeneration({
        chatId,
        userId,
        chatType,
        generationId: value,
      });
      await ctx.reply(
        generation ? formatGeneration(generation) : "未找到任务，或你无权查看该任务。",
      );
      return;
    }

    if (action === "retry" && value && cfg.retryDelivery) {
      const result = await cfg.retryDelivery({ chatId, userId, chatType, generationId: value });
      await ctx.reply(
        result.ok
          ? "已安排原图片投递重试，尚未确认交付。"
          : result.reason === "delivery_unknown"
            ? "投递结果未知，禁止重发；请核对原聊天与回执。"
            : "无法重试：仅允许已生成且确定未发送的任务。",
      );
      return;
    }

    if (action === "cancel" && value) {
      const result = await cfg.cancelGeneration({
        chatId,
        userId,
        chatType,
        generationId: value,
      });
      if (!result.ok) {
        await ctx.reply(
          result.message ??
            (result.generation
              ? `取消未确认；原任务继续跟踪。\n${formatGeneration(result.generation)}`
              : "无法取消：任务不存在、已结束或你无权操作。"),
        );
        return;
      }
      await ctx.reply(
        result.generation
          ? formatGeneration(result.generation)
          : (result.message ?? "取消请求已提交。"),
      );
      return;
    }

    await ctx.reply(USAGE);
  };
}
