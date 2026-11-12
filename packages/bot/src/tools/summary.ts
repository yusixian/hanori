import type { ChatSummaryCallback } from "@cos-tool-bot/shared";
import { tool } from "ai";
import { z } from "zod";
import { zodToAiSchema } from "./utils.js";

export function createSummaryTools(
  callback: ChatSummaryCallback,
  source: { chatId: number; threadId?: number; userId: number; signal?: AbortSignal },
) {
  return {
    summarize_chat: tool({
      description:
        "总结当前聊天/话题中允许读取的已存储记录，使用独立总结模型并在服务端分块；只返回摘要与coverage，不发送消息、不返回全量原文。支持自定义要求、mode或明确since/until（ISO时间，最长72小时）；最多2000条或配置上限。complete仅代表允许范围内数据库记录读完，不代表Telegram全部历史。",
      inputSchema: zodToAiSchema(
        z
          .object({
            mode: z
              .discriminatedUnion("kind", [
                z.object({ kind: z.literal("default") }),
                z.object({ kind: z.literal("recent"), count: z.number().int().min(1).max(2000) }),
                z.object({ kind: z.literal("hours"), hours: z.number().int().min(1).max(72) }),
                z.object({ kind: z.literal("date"), day: z.enum(["today", "yesterday"]) }),
              ])
              .optional(),
            since: z.string().datetime({ offset: true }).optional(),
            until: z.string().datetime({ offset: true }).optional(),
            instructions: z.string().max(8000).optional(),
            maxMessages: z.number().int().min(1).max(2000).optional(),
          })
          .strict(),
      ),
      execute: (request) => callback({ ...source, request }),
    }),
  };
}
