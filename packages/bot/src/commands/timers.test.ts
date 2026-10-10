import type { WrapperContext } from "../context.js";
import { expect, it, vi } from "vitest";
import { createTimerCancelCallbackQueryHandler } from "./timers.js";

function fixture(userId = 42, data = "cos:tc:timer-a", cancelled = true) {
  const cancel = vi.fn().mockResolvedValue(cancelled);
  const answer = vi.fn().mockResolvedValue(true);
  const edit = vi.fn().mockResolvedValue(true);
  const handler = createTimerCancelCallbackQueryHandler({ adminIds: [42], onCancelTimer: cancel });
  const ctx = {
    callbackQuery: {
      id: "callback",
      data,
      from: { id: userId },
      message: { chat: { id: -100 }, message_id: 7, text: "timers" },
    },
    api: { raw: { answerCallbackQuery: answer }, editMessageText: edit },
  } as unknown as Pick<WrapperContext, "callbackQuery" | "api">;
  return { handler, ctx, cancel, answer, edit };
}

it("rejects a non-admin clicking the administrator's timer button", async () => {
  const { handler, ctx, cancel, answer, edit } = fixture(99);
  await expect(handler(ctx)).resolves.toBe(true);
  expect(cancel).not.toHaveBeenCalled();
  expect(edit).not.toHaveBeenCalled();
  expect(answer).toHaveBeenCalledWith({
    callback_query_id: "callback",
    text: "仅管理员可取消定时器。",
  });
});

it("allows an administrator to cancel from a group message", async () => {
  const { handler, ctx, cancel, answer, edit } = fixture();
  await expect(handler(ctx)).resolves.toBe(true);
  expect(cancel).toHaveBeenCalledExactlyOnceWith("timer-a");
  expect(answer).toHaveBeenCalledWith({
    callback_query_id: "callback",
    text: "定时器 timer-a 已取消",
  });
  expect(edit).toHaveBeenCalledWith(-100, 7, "timers\n\n✅ 定时器 timer-a 已取消");
});

it("does not edit a message when the timer is no longer cancellable", async () => {
  const { handler, ctx, answer, edit } = fixture(42, "cos:tc:timer-a", false);
  await expect(handler(ctx)).resolves.toBe(true);
  expect(answer).toHaveBeenCalledWith({
    callback_query_id: "callback",
    text: "定时器未找到或已过期",
  });
  expect(edit).not.toHaveBeenCalled();
});

it.each(["cos:tc:", "other:action"])(
  "leaves unrelated or empty callbacks to other handlers: %s",
  async (data) => {
    const { handler, ctx, cancel, answer } = fixture(42, data);
    await expect(handler(ctx)).resolves.toBe(false);
    expect(cancel).not.toHaveBeenCalled();
    expect(answer).not.toHaveBeenCalled();
  },
);
