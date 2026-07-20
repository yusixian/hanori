import { DEFAULT_MESSAGE_CONFIG } from "@cos-tool-bot/shared";
import type { Api } from "grammy";
import type { Message } from "grammy/types";
import { describe, expect, it, vi } from "vitest";
import type { WrapperContext } from "../context.js";
import { safeFormattedReply, sendFormattedChunks } from "./ai-reply.js";

function sentMessage(messageId: number): Message.TextMessage {
  return {
    message_id: messageId,
    date: 0,
    chat: { id: -100, type: "supergroup" },
    text: "sent",
  } as Message.TextMessage;
}

function createContext(options?: {
  sendRichMessage?: ReturnType<typeof vi.fn>;
  sendMessage?: ReturnType<typeof vi.fn>;
}) {
  const sendRichMessage = options?.sendRichMessage ?? vi.fn().mockResolvedValue(sentMessage(20));
  const sendMessage = options?.sendMessage ?? vi.fn().mockResolvedValue(sentMessage(21));
  const sendChatAction = vi.fn().mockResolvedValue(true);
  const directlyReply = vi.fn().mockResolvedValue(sentMessage(11));
  const waitingMessage = sentMessage(10);
  const ctx = {
    api: { sendRichMessage, sendMessage, sendChatAction } as unknown as Api,
    chat: { id: -100, type: "supergroup" },
    message: { message_id: 5, message_thread_id: 77 },
    waiting_message: waitingMessage,
    deleteWaiting: vi.fn(async () => {
      ctx.waiting_message = undefined;
    }),
    directlyReply,
    resolveWait: vi.fn(async (text: string) => {
      if (ctx.waiting_message) return ctx.waiting_message.message_id;
      return (await directlyReply(text)).message_id;
    }),
  } as unknown as WrapperContext;
  return { ctx, sendRichMessage, sendMessage, sendChatAction, directlyReply };
}

describe("AI reply delivery", () => {
  it("keeps the waiting message until a topic reply is persisted", async () => {
    let ctx!: WrapperContext;
    const sendRichMessage = vi.fn().mockImplementation(async () => {
      expect(ctx.waiting_message?.message_id).toBe(10);
      expect(ctx.deleteWaiting).not.toHaveBeenCalled();
      return sentMessage(20);
    });
    ({ ctx } = createContext({ sendRichMessage }));

    await expect(safeFormattedReply(ctx, "# Complete", true)).resolves.toBe(20);
    expect(sendRichMessage).toHaveBeenCalledWith(
      -100,
      { markdown: "# Complete" },
      {
        message_thread_id: 77,
        reply_parameters: { message_id: 5 },
      },
    );
    expect(ctx.deleteWaiting).toHaveBeenCalledOnce();
  });

  it("retries without reply_parameters before editing the waiting message", async () => {
    const sendRichMessage = vi.fn().mockRejectedValue(new Error("reply target missing"));
    const sendMessage = vi.fn().mockImplementation(async (_chatId, _text, options) => {
      if (options?.reply_parameters) throw new Error("reply target missing");
      return sentMessage(22);
    });
    const { ctx } = createContext({ sendRichMessage, sendMessage });

    await expect(safeFormattedReply(ctx, "# Complete", true)).resolves.toBe(22);
    expect(sendRichMessage).toHaveBeenCalledTimes(2);
    expect(sendMessage).toHaveBeenLastCalledWith(-100, "<b>Complete</b>", {
      message_thread_id: 77,
      parse_mode: "HTML",
    });
    expect(ctx.resolveWait).not.toHaveBeenCalled();
    expect(ctx.deleteWaiting).toHaveBeenCalledOnce();
  });

  it("falls back to editing waiting only after both new-message attempts fail", async () => {
    const sendRichMessage = vi.fn().mockRejectedValue(new Error("send failed"));
    const sendMessage = vi.fn().mockRejectedValue(new Error("send failed"));
    const { ctx } = createContext({ sendRichMessage, sendMessage });

    await expect(safeFormattedReply(ctx, "# Complete", true)).resolves.toBe(10);
    expect(sendRichMessage).toHaveBeenCalledTimes(2);
    expect(ctx.deleteWaiting).not.toHaveBeenCalled();
    expect(ctx.resolveWait).toHaveBeenCalledWith("<b>Complete</b>", "HTML");
  });

  it("deletes the waiting status after direct fallback delivery succeeds", async () => {
    const { ctx, directlyReply } = createContext();
    vi.mocked(ctx.resolveWait).mockRejectedValue(new Error("edit failed"));

    await expect(safeFormattedReply(ctx, "# Complete", false)).resolves.toBe(11);

    expect(ctx.resolveWait).toHaveBeenCalledTimes(2);
    expect(directlyReply).toHaveBeenCalledWith("# Complete");
    expect(ctx.deleteWaiting).toHaveBeenCalledOnce();
    expect(ctx.waiting_message).toBeUndefined();
  });

  it("splits a long Rich fallback using the configured threshold", async () => {
    let nextMessageId = 30;
    const sendRichMessage = vi.fn().mockImplementation(async (_chatId, richMessage) => {
      expect(richMessage.markdown.length).toBeLessThanOrEqual(3000);
      return sentMessage(nextMessageId++);
    });
    const { ctx, sendChatAction } = createContext({ sendRichMessage });

    const richText = Array.from(
      { length: 6 },
      (_, index) => `# Heading ${index}\n${"x".repeat(1400)}`,
    ).join("\n\n");
    const messageIds = await sendFormattedChunks(
      ctx,
      richText,
      { ...DEFAULT_MESSAGE_CONFIG, autoSplitThreshold: 3000, splitDelayMs: 0 },
      true,
    );

    expect(messageIds).toEqual([30, 31, 32]);
    expect(sendRichMessage).toHaveBeenCalledTimes(3);
    expect(sendChatAction).toHaveBeenCalledTimes(2);
  });

  it("keeps every chunk when Rich Messages are disabled", async () => {
    const { ctx, directlyReply } = createContext();

    const messageIds = await sendFormattedChunks(
      ctx,
      "x".repeat(5000),
      { ...DEFAULT_MESSAGE_CONFIG, autoSplitThreshold: 0, splitDelayMs: 0 },
      false,
    );

    expect(messageIds).toEqual([10, 11]);
    expect(ctx.resolveWait).toHaveBeenCalledTimes(2);
    expect(directlyReply).toHaveBeenCalledTimes(1);
    for (const [text] of vi.mocked(ctx.resolveWait).mock.calls) {
      expect(text.length).toBeLessThanOrEqual(4096);
    }
  });

  it("detaches a waiting-message fallback before delivering the next Rich chunk", async () => {
    const sendRichMessage = vi.fn().mockRejectedValue(new Error("send failed"));
    const sendMessage = vi.fn().mockRejectedValue(new Error("send failed"));
    const { ctx, directlyReply } = createContext({ sendRichMessage, sendMessage });
    const richText = `# First\n${"x".repeat(2500)}\n\n# Second\n${"y".repeat(2500)}`;

    const messageIds = await sendFormattedChunks(
      ctx,
      richText,
      { ...DEFAULT_MESSAGE_CONFIG, autoSplitThreshold: 3000, splitDelayMs: 0 },
      true,
    );

    expect(messageIds).toEqual([10, 11]);
    expect(ctx.waiting_message).toBeUndefined();
    expect(directlyReply).toHaveBeenCalledTimes(1);
  });
});
