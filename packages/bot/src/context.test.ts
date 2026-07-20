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
  const editMessageText = vi.fn().mockResolvedValue(true);
  Object.defineProperty(ctx, "api", { value: { editMessageText }, configurable: true });
  const deleteMessages = vi.spyOn(ctx, "deleteMessages").mockResolvedValue(true);
  return { ctx, deleteMessages, editMessageText };
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

    await vi.waitFor(() => expect(directlyReply).toHaveBeenCalledOnce());
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

  it("preserves edit and cleanup invocation order", async () => {
    const { ctx, deleteMessages, editMessageText } = createContext();
    ctx.waiting_message = sentMessage(10);
    let finishStatusEdit!: () => void;
    const statusEditPending = new Promise<true>((resolve) => {
      finishStatusEdit = () => resolve(true);
    });
    editMessageText.mockReturnValueOnce(statusEditPending).mockResolvedValueOnce(true);

    const statusEdit = ctx.resolveWait("💭 回复中...");
    const finalEdit = ctx.resolveWait("最终回复", "HTML");
    const cleanup = ctx.deleteWaiting();

    await vi.waitFor(() => expect(editMessageText).toHaveBeenCalledOnce());
    expect(editMessageText).toHaveBeenLastCalledWith(1, 10, "💭 回复中...", {
      parse_mode: undefined,
    });
    expect(deleteMessages).not.toHaveBeenCalled();

    finishStatusEdit();
    await Promise.all([statusEdit, finalEdit, cleanup]);

    expect(editMessageText.mock.calls.map((call) => call[2])).toEqual(["💭 回复中...", "最终回复"]);
    expect(deleteMessages).toHaveBeenCalledWith([10]);
    expect(ctx.waiting_message).toBeUndefined();
  });

  it("continues queued mutations after an edit fails", async () => {
    const { ctx, editMessageText } = createContext();
    ctx.waiting_message = sentMessage(10);
    editMessageText
      .mockRejectedValueOnce(new Error("status edit failed"))
      .mockResolvedValueOnce(true);

    const failedStatus = ctx.resolveWait("💭 回复中...");
    const finalReply = ctx.resolveWait("最终回复", "HTML");

    await expect(failedStatus).rejects.toThrow("status edit failed");
    await expect(finalReply).resolves.toBe(10);
    expect(editMessageText.mock.calls.map((call) => call[2])).toEqual(["💭 回复中...", "最终回复"]);
  });
});
