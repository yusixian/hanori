import { zValidator } from "@hono/zod-validator";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import type { BotPool } from "../services/bot-pool.js";
import {
  BotNotRunningError,
  TelegramRichMessagesUnsupportedError,
} from "../services/telegram-rich-message-errors.js";

const sendRichMessageSchema = z.object({
  chatId: z
    .string()
    .trim()
    .regex(/^-?\d+$/, "chatId must be an integer")
    .transform(Number)
    .pipe(
      z
        .number()
        .int()
        .safe()
        .refine((value) => value !== 0, "chatId must be non-zero"),
    ),
  format: z.enum(["markdown", "html"]),
  content: z
    .string()
    .max(32_768)
    .refine((value) => value.trim().length > 0, "content must not be empty"),
});

type RichMessageSender = Pick<BotPool, "sendRichMessage">;

export function botDebugRoutes(botPool: RichMessageSender) {
  return new Hono().post(
    "/:botId/debug/rich-messages",
    zValidator("json", sendRichMessageSchema),
    async (c) => {
      const { chatId, format, content } = c.req.valid("json");
      try {
        const receipt = await botPool.sendRichMessage(
          c.req.param("botId"),
          chatId,
          format,
          content,
        );
        return c.json({ ok: true as const, data: receipt });
      } catch (error) {
        const status =
          error instanceof BotNotRunningError ||
          error instanceof TelegramRichMessagesUnsupportedError
            ? 409
            : 502;
        throw new HTTPException(status, {
          message: error instanceof Error ? error.message : String(error),
        });
      }
    },
  );
}
