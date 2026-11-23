import type { QuoteSource } from "@cos-tool-bot/shared";
import { tool } from "ai";
import { z } from "zod";
import { QuoteError, type QuoteService } from "../services/quote-service.js";
import { wrapOnce, zodToAiSchema, type OnceGuardContext } from "./utils.js";

export function createQuoteTools(
  service: QuoteService,
  options: {
    chatId: number;
    threadId?: number;
    userId: number;
    visibleIds: () => readonly number[];
    sources?: readonly QuoteSource[];
    onceGuard: OnceGuardContext;
    signal?: AbortSignal;
    replyToMessageId?: number;
    onSent?: (id: number) => void;
  },
) {
  return {
    create_quote_sticker: tool({
      description:
        "把本轮可见的真实消息制作成语录贴纸并发送一次；长内容自动发送可读PNG。适合明确请求或少量值得纪念的群聊片段，不要刷屏。message_ids只能来自当前上下文；quote_text只可截取单条原文，不能改写或捏造。受保护、隐私off及生成的语录不可引用。",
      inputSchema: zodToAiSchema(
        z
          .object({
            message_ids: z.array(z.number().int().positive()).min(1).max(10),
            quote_text: z.string().min(1).max(32768).optional(),
            include_reply_preview: z.boolean().optional(),
            color: z.string().max(20).optional(),
          })
          .strict(),
      ),
      execute: wrapOnce(
        "create_quote_sticker",
        options.onceGuard,
        async (args: {
          message_ids: number[];
          quote_text?: string;
          include_reply_preview?: boolean;
          color?: string;
        }) => {
          if (args.message_ids.some((id) => !options.visibleIds().includes(id)))
            return { error: "只能引用本轮上下文中真实可见的消息 ID。" };
          try {
            const result = await service.send({
              chatId: options.chatId,
              threadId: options.threadId ?? null,
              userId: options.userId,
              messageIds: args.message_ids,
              liveSources: structuredClone(options.sources ?? []).filter((source) =>
                options.visibleIds().includes(source.messageId),
              ),
              snapshotOnly: true,
              quoteText: args.quote_text,
              includeReplyPreview: args.include_reply_preview,
              color: args.color,
              signal: options.signal,
              replyToMessageId: options.replyToMessageId,
            });
            options.onSent?.(result.messageId);
            return {
              success: true,
              message_id: result.messageId,
              format: result.format,
              count: result.count,
              notice: result.notice,
              receipt_saved: result.receiptSaved,
            };
          } catch (error) {
            return {
              error:
                error instanceof QuoteError
                  ? error.message
                  : "语录生成或发送失败；发送结果可能未知，请先检查聊天，不要重复调用。",
            };
          }
        },
      ),
    }),
  };
}
