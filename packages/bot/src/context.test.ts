import type { Message } from "grammy/types";
import { describe, expect, it, vi } from "vitest";
import { WrapperContext } from "./context.js";

function sentMessage(messageId: number): Message.TextMessage {
  return {
    message_id: messageId,
    date: 0,
    chat: { id: 1, type: "private" },
    text: "status",
  } as Message.TextMessage;
}

function createContext() {
  const ctx = Object.create(WrapperContext.prototype) as WrapperContext;
  const deleteMessages = vi.spyOn(ctx, "deleteMessages").mockResolvedValue(true);
  return { ctx, deleteMessages };
}

describe("WrapperContext waiting message", () => {
  it("shares one status message between concurrent waits", async () => {
    const { ctx } = createContext();
    let finishSend!: (message: Message.TextMessage) => void;
    const sendPending = new Promise<Message.TextMessage>((resolve) => {
      finishSend = resolve;
    });
    const directlyReply = vi.spyOn(ctx, "directlyReply").mockReturnValue(sendPending);

    const waits = Promise.all([ctx.wait("🖼️ 查看作品..."), ctx.wait("🖼️ 查看作品...")]);

    expect(directlyReply).toHaveBeenCalledOnce();
    finishSend(sentMessage(10));
    await waits;
    expect(ctx.waiting_message?.message_id).toBe(10);
  });

  it("deletes a status message whose send is still pending", async () => {
    const { ctx, deleteMessages } = createContext();
    let finishSend!: (message: Message.TextMessage) => void;
    const sendPending = new Promise<Message.TextMessage>((resolve) => {
      finishSend = resolve;
    });
    vi.spyOn(ctx, "directlyReply").mockReturnValue(sendPending);

    const wait = ctx.wait("🖼️ 查看作品...");
    const cleanup = ctx.deleteWaiting();
    finishSend(sentMessage(10));
    await Promise.all([wait, cleanup]);

    expect(deleteMessages).toHaveBeenCalledWith([10]);
    expect(ctx.waiting_message).toBeUndefined();
  });
});
