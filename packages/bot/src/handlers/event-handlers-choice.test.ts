import type { Api } from "grammy";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ContinuationNotDeliveredError,
  type ContinueChatConfig,
} from "../services/continue-chat.js";
import { AiRunCancelledError } from "../services/ai-execution-coordinator.js";
import { PendingActionRegistry } from "../services/pending-actions.js";

const { continueChatMock } = vi.hoisted(() => ({ continueChatMock: vi.fn() }));

vi.mock("../services/continue-chat.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../services/continue-chat.js")>()),
  continueChat: continueChatMock,
}));

import { createCallbackQueryHandler } from "./event-handlers.js";

const CHAT_ID = -100;
const TARGET_USER_ID = 42;
const registries: PendingActionRegistry[] = [];

afterEach(() => {
  vi.clearAllMocks();
  for (const registry of registries.splice(0)) registry.destroy();
});

function createRegistry(targetUserId?: number) {
  const registry = new PendingActionRegistry();
  registries.push(registry);
  registry.registerChoice(
    "choice-1",
    CHAT_ID,
    77,
    "选择头像风格",
    ["侧脸少年", "阳光少女"],
    targetUserId,
  );
  return registry;
}

function createApi() {
  const answerCallbackQuery = vi.fn().mockResolvedValue(true);
  const editMessageText = vi.fn().mockResolvedValue(true);
  const sendMessage = vi.fn().mockResolvedValue({ message_id: 88 });
  return {
    api: {
      raw: { answerCallbackQuery },
      editMessageText,
      sendMessage,
    } as unknown as Api,
    answerCallbackQuery,
    editMessageText,
    sendMessage,
  };
}

function callback(userId = TARGET_USER_ID, callbackId = "callback-1") {
  return {
    callbackQuery: {
      id: callbackId,
      data: "cos:c:choice-1:0",
      from: { id: userId, first_name: "Krau", last_name: "Tester" },
      message: { chat: { id: CHAT_ID }, message_id: 77 },
    },
  };
}

function createHandler(api: Api, pendingActions: PendingActionRegistry, onLog = vi.fn()) {
  return createCallbackQueryHandler({
    api,
    pendingActions,
    getContinueChatConfig: vi.fn().mockReturnValue({ onLog } as unknown as ContinueChatConfig),
    onLog,
  });
}

describe("send_choice callback continuation", () => {
  it("continues a claimed choice when callback acknowledgement and message editing fail", async () => {
    continueChatMock.mockResolvedValue(true);
    const pendingActions = createRegistry(TARGET_USER_ID);
    const { api, answerCallbackQuery, editMessageText, sendMessage } = createApi();
    answerCallbackQuery.mockRejectedValueOnce(new Error("callback query expired"));
    editMessageText.mockRejectedValueOnce(new Error("message cannot be edited"));
    const handler = createHandler(api, pendingActions);

    await handler(callback());

    expect(continueChatMock).toHaveBeenCalledWith(
      api,
      expect.anything(),
      expect.objectContaining({
        chatId: CHAT_ID,
        userId: TARGET_USER_ID,
        userName: "Krau Tester",
        requireDelivery: true,
        failureMessage: "已记录你的选择「侧脸少年」，但暂时无法继续处理，请稍后再试。",
        eventDescription: expect.stringContaining("侧脸少年"),
      }),
    );
    expect(pendingActions.getChoice("choice-1")).toBeUndefined();
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it.each([
    ["returns false", () => continueChatMock.mockResolvedValueOnce(false)],
    ["throws", () => continueChatMock.mockRejectedValueOnce(new Error("model unavailable"))],
    [
      "is denied by usage governance",
      () =>
        continueChatMock.mockRejectedValueOnce(new ContinuationNotDeliveredError("usage_denied")),
    ],
  ])("delegates failure delivery when continuation %s", async (_label, arrange) => {
    arrange();
    const pendingActions = createRegistry();
    const { api, sendMessage } = createApi();
    const handler = createHandler(api, pendingActions);

    await handler(callback());

    expect(continueChatMock).toHaveBeenCalledWith(
      api,
      expect.anything(),
      expect.objectContaining({
        failureMessage: "已记录你的选择「侧脸少年」，但暂时无法继续处理，请稍后再试。",
      }),
    );
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it.each([
    ["AI is disabled", new ContinuationNotDeliveredError("ai_disabled")],
    ["personalization is off", new ContinuationNotDeliveredError("privacy_off")],
    ["the execution was cancelled", new ContinuationNotDeliveredError("execution_cancelled")],
    ["the runtime was destroyed", new AiRunCancelledError("runtime destroyed")],
  ])("preserves cancellation semantics when %s", async (_label, error) => {
    continueChatMock.mockRejectedValueOnce(error);
    const pendingActions = createRegistry();
    const { api, sendMessage } = createApi();
    const handler = createHandler(api, pendingActions);

    await handler(callback());

    expect(sendMessage).not.toHaveBeenCalled();
  });

  it("rejects a non-target user without consuming the choice", async () => {
    const pendingActions = createRegistry(TARGET_USER_ID);
    const { api, answerCallbackQuery, sendMessage } = createApi();
    const onLog = vi.fn();
    const handler = createHandler(api, pendingActions, onLog);

    await handler(callback(99));

    expect(answerCallbackQuery).toHaveBeenCalledWith({
      callback_query_id: "callback-1",
      text: "这个选择不是给你的哦",
      show_alert: true,
    });
    expect(pendingActions.getChoice("choice-1")?.resolved).toBe(false);
    expect(continueChatMock).not.toHaveBeenCalled();
    expect(sendMessage).not.toHaveBeenCalled();
    expect(onLog).toHaveBeenCalledWith({
      level: "info",
      message: "send_choice callback received",
      meta: {
        chatId: CHAT_ID,
        userId: 99,
        choiceId: "choice-1",
        optionIndex: 0,
      },
    });
    expect(onLog).toHaveBeenCalledWith({
      level: "info",
      message: "send_choice callback rejected for non-target user",
      meta: {
        chatId: CHAT_ID,
        userId: 99,
        choiceId: "choice-1",
        optionIndex: 0,
        targetUserId: TARGET_USER_ID,
      },
    });
  });

  it("claims a choice once when the same button is clicked repeatedly", async () => {
    let finishContinuation!: (delivered: boolean) => void;
    continueChatMock.mockReturnValueOnce(
      new Promise<boolean>((resolve) => {
        finishContinuation = resolve;
      }),
    );
    const pendingActions = createRegistry();
    const { api, answerCallbackQuery } = createApi();
    const onLog = vi.fn();
    const handler = createHandler(api, pendingActions, onLog);

    const first = handler(callback(TARGET_USER_ID, "callback-1"));
    await vi.waitFor(() => expect(continueChatMock).toHaveBeenCalledOnce());
    await handler(callback(TARGET_USER_ID, "callback-2"));
    finishContinuation(true);
    await first;

    expect(continueChatMock).toHaveBeenCalledOnce();
    expect(answerCallbackQuery).toHaveBeenCalledWith({
      callback_query_id: "callback-2",
      text: "该选择已过期",
    });
    expect(onLog).toHaveBeenCalledWith({
      level: "info",
      message: "send_choice callback expired",
      meta: {
        chatId: CHAT_ID,
        userId: TARGET_USER_ID,
        choiceId: "choice-1",
        optionIndex: 0,
      },
    });
  });

  it("does not consume the choice if continuation config construction fails", async () => {
    const pendingActions = createRegistry();
    const { api } = createApi();
    const handler = createCallbackQueryHandler({
      api,
      pendingActions,
      getContinueChatConfig: () => {
        throw new Error("runtime config unavailable");
      },
    });

    await expect(handler(callback())).rejects.toThrow("runtime config unavailable");

    expect(pendingActions.getChoice("choice-1")?.resolved).toBe(false);
    expect(continueChatMock).not.toHaveBeenCalled();
  });
});
