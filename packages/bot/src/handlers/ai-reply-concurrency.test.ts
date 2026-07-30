import type { Api } from "grammy";
import type { Message, Update, UserFromGetMe } from "grammy/types";
import type {
  ConversationCallbacks,
  UserPrivacyCallbacks,
  UserPrivacyMode,
} from "@cos-tool-bot/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WrapperContext, type BotContext } from "../context.js";
import { AiRunCancelledError } from "../services/ai-execution-coordinator.js";
import { AiIngressLock } from "../services/ai-ingress-lock.js";
import { createAiReplyHandler, type AiReplyConfig } from "./ai-reply.js";

const { streamTextMock } = vi.hoisted(() => ({ streamTextMock: vi.fn() }));

vi.mock("ai", async (importOriginal) => ({
  ...(await importOriginal<typeof import("ai")>()),
  streamText: streamTextMock,
}));

const CHAT_ID = -100;
const USER_ID = 42;
const QUEUE_NOTICE = "助手正在忙哦，一会儿就来陪你哦～";
const runtimes: Array<ReturnType<typeof createAiReplyHandler>> = [];

beforeEach(() => {
  streamTextMock.mockReset();
});

afterEach(async () => {
  await Promise.allSettled(runtimes.splice(0).map((runtime) => runtime.destroy()));
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

function sentMessage(messageId: number, text: string): Message.TextMessage {
  return {
    message_id: messageId,
    date: 0,
    chat: { id: CHAT_ID, type: "supergroup", title: "Test group" },
    text,
  } as Message.TextMessage;
}

function createApi() {
  let nextMessageId = 202;
  let nextRichMessageId = 300;
  const sendMessage = vi.fn(
    async (_chatId: number, text: string, _options?: Record<string, unknown>) =>
      sentMessage(nextMessageId++, text),
  );
  const sendRichMessage = vi.fn(
    async (_chatId: number, _input: { markdown: string }, _options?: Record<string, unknown>) =>
      sentMessage(nextRichMessageId++, "rich"),
  );
  const editMessageText = vi.fn().mockResolvedValue(true);
  const deleteMessages = vi.fn().mockResolvedValue(true);
  const sendChatAction = vi.fn().mockResolvedValue(true);
  const api = {
    sendMessage,
    sendRichMessage,
    editMessageText,
    sendChatAction,
    deleteMessages,
  } as unknown as Api;
  return { api, sendMessage, sendRichMessage, editMessageText, deleteMessages, sendChatAction };
}

function createContext(
  api: Api,
  updateId: number,
  messageId: number,
  text: string,
  userId = USER_ID,
): BotContext {
  const update = {
    update_id: updateId,
    message: {
      message_id: messageId,
      date: 0,
      chat: { id: CHAT_ID, type: "supergroup", title: "Test group" },
      from: { id: userId, is_bot: false, first_name: "Tester" },
      text,
      entities: [],
    },
  } as Update;
  const me = {
    id: 99,
    is_bot: true,
    first_name: "Ai",
    username: "sample_bot",
  } as UserFromGetMe;
  return new WrapperContext(update, api, me) as BotContext;
}

function createConfig(queueNoticeEnabled: boolean, onLog = vi.fn()): AiReplyConfig {
  return {
    botId: "bot-1",
    apiKey: "key",
    baseURL: "https://example.com/v1",
    model: "model",
    systemPrompt: "system",
    triggerConfig: {
      replyToBot: true,
      mentionBot: true,
      triggerWords: ["sample"],
      randomReplyPercent: 0,
      randomReplyCooldown: 60,
    },
    groupOverrides: {
      [CHAT_ID]: { chatId: CHAT_ID, whitelisted: true },
    },
    adminChatIds: [],
    messageConfig: {
      replyMode: "segment",
      richMessageEnabled: true,
      autoSplitThreshold: 0,
      splitDelayMs: 0,
    },
    executionConfig: {
      maxConcurrentReplies: 4,
      queueNotice: { enabled: queueNoticeEnabled, text: QUEUE_NOTICE },
    },
    detachReplyExecution: true,
    token: "token",
    onLog,
  };
}

function streamResult(text: Promise<string>) {
  async function* textStream() {
    yield await text;
  }
  return {
    textStream: textStream(),
    text,
    steps: Promise.resolve([]),
    usage: Promise.resolve({ inputTokens: 1, outputTokens: 1, totalTokens: 2 }),
    finishReason: Promise.resolve("stop"),
  };
}

describe("AI reply queue delivery", () => {
  it("freezes ring-buffer context at ingress so an active turn cannot see later messages", async () => {
    const typingGate = deferred<void>();
    streamTextMock
      .mockImplementationOnce(() => streamResult(Promise.resolve("# Active final")))
      .mockImplementationOnce(() => streamResult(Promise.resolve("# Queued final")));
    const onLog = vi.fn();
    const { api, sendChatAction } = createApi();
    sendChatAction.mockImplementationOnce(() => typingGate.promise);
    const runtime = createAiReplyHandler(createConfig(true, onLog));
    runtimes.push(runtime);

    await runtime.handler(createContext(api, 1, 11, "sample first"), vi.fn());
    await vi.waitFor(() => expect(sendChatAction).toHaveBeenCalledOnce());
    await runtime.handler(createContext(api, 2, 12, "sample future"), vi.fn());
    expect(streamTextMock).not.toHaveBeenCalled();

    typingGate.resolve();

    await vi.waitFor(() => expect(streamTextMock).toHaveBeenCalled());
    expect(JSON.stringify(streamTextMock.mock.calls[0]?.[0]?.messages)).not.toContain(
      "sample future",
    );
    await vi.waitFor(() =>
      expect(onLog.mock.calls.filter(([entry]) => entry.message === "AI reply sent")).toHaveLength(
        2,
      ),
    );
  });

  it("bounds persisted group history before the current message row", async () => {
    const typingGate = deferred<void>();
    streamTextMock
      .mockImplementationOnce(() => streamResult(Promise.resolve("# Active final")))
      .mockImplementationOnce(() => streamResult(Promise.resolve("# Queued final")));
    const { api, sendChatAction } = createApi();
    sendChatAction.mockImplementationOnce(() => typingGate.promise);
    const rowIds = new Map([
      ["telegram:11:user", 101],
      ["telegram:12:user", 102],
    ]);
    const getHistory = vi.fn().mockResolvedValue({ summary: null, messages: [] });
    const conversation: ConversationCallbacks = {
      getHistory,
      addMessage: vi.fn(),
      addMessages: vi.fn(),
      upsertUserMessage: vi.fn(async (message) => ({ id: rowIds.get(message.sourceKey)! })),
      triggerCompression: vi.fn(),
      clearHistory: vi.fn(),
    };
    const config = createConfig(true);
    config.conversation = conversation;
    const runtime = createAiReplyHandler(config);
    runtimes.push(runtime);

    await runtime.handler(createContext(api, 1, 11, "sample first"), vi.fn());
    await vi.waitFor(() => expect(sendChatAction).toHaveBeenCalledOnce());
    await runtime.handler(createContext(api, 2, 12, "sample second"), vi.fn());

    typingGate.resolve();

    await vi.waitFor(() => expect(getHistory).toHaveBeenCalled());
    expect(getHistory.mock.calls[0]?.[3]).toEqual({
      excludeSourceKey: "telegram:11:user",
      beforeId: 101,
      beforeTelegramMessageId: 11,
    });
  });

  it("reads cross-chat history at the watermark captured when the turn was admitted", async () => {
    const typingGate = deferred<void>();
    streamTextMock
      .mockImplementationOnce(() => streamResult(Promise.resolve("# Active final")))
      .mockImplementationOnce(() => streamResult(Promise.resolve("# Queued final")));
    const { api, sendChatAction } = createApi();
    sendChatAction.mockImplementationOnce(() => typingGate.promise);
    const watermarks = [101, 102];
    const getHistoryWatermark = vi.fn(async () => watermarks.shift() ?? 999);
    const getRecentUserMessagesAcrossChats = vi.fn().mockResolvedValue([]);
    const conversation: ConversationCallbacks = {
      getHistory: vi.fn().mockResolvedValue({ summary: null, messages: [] }),
      getRecentUserMessagesAcrossChats,
      getHistoryWatermark,
      addMessage: vi.fn(),
      addMessages: vi.fn().mockResolvedValue(undefined),
      upsertUserMessage: vi.fn().mockResolvedValue({ id: 101 }),
      triggerCompression: vi.fn(),
      clearHistory: vi.fn(),
    };
    const config = createConfig(true);
    config.conversation = conversation;
    const runtime = createAiReplyHandler(config);
    runtimes.push(runtime);

    await runtime.handler(createContext(api, 1, 11, "sample first"), vi.fn());
    await vi.waitFor(() => expect(sendChatAction).toHaveBeenCalledOnce());
    await runtime.handler(createContext(api, 2, 12, "sample second"), vi.fn());

    expect(getHistoryWatermark).toHaveBeenCalledTimes(2);
    expect(getRecentUserMessagesAcrossChats).not.toHaveBeenCalled();

    typingGate.resolve();

    await vi.waitFor(() => expect(getRecentUserMessagesAcrossChats).toHaveBeenCalledTimes(2));
    expect(getRecentUserMessagesAcrossChats.mock.calls.map((call) => call[3])).toEqual([101, 102]);
  });

  it("links every persisted group turn row to its ingress user row", async () => {
    streamTextMock.mockImplementationOnce(() => streamResult(Promise.resolve("# Final")));
    const { api } = createApi();
    const addMessages = vi.fn().mockResolvedValue([]);
    const completeTurn = vi.fn().mockResolvedValue(undefined);
    const conversation: ConversationCallbacks = {
      getHistory: vi.fn().mockResolvedValue({ summary: null, messages: [] }),
      addMessage: vi.fn(),
      addMessages,
      upsertUserMessage: vi.fn().mockResolvedValue({ id: 101 }),
      completeTurn,
      triggerCompression: vi.fn(),
      clearHistory: vi.fn(),
    };
    const config = createConfig(true);
    config.conversation = conversation;
    const runtime = createAiReplyHandler(config);
    runtimes.push(runtime);

    await runtime.handler(createContext(api, 1, 11, "sample first"), vi.fn());

    await vi.waitFor(() => expect(addMessages).toHaveBeenCalledOnce());
    const persisted = addMessages.mock.calls[0]?.[0] as Array<{
      role: string;
      meta?: Record<string, unknown>;
    }>;
    expect(persisted).not.toHaveLength(0);
    expect(persisted.every((message) => message.meta?.["turnOrderId"] === 101)).toBe(true);
    await vi.waitFor(() =>
      expect(completeTurn).toHaveBeenCalledWith(CHAT_ID, "telegram:11:user", 101),
    );
  });

  it("finalizes group persistence even when the ingress callback returns no row id", async () => {
    streamTextMock.mockImplementationOnce(() => streamResult(Promise.resolve("# Final")));
    const { api } = createApi();
    const completeTurn = vi.fn().mockResolvedValue(undefined);
    const triggerCompression = vi.fn().mockResolvedValue(undefined);
    const conversation: ConversationCallbacks = {
      getHistory: vi.fn().mockResolvedValue({ summary: null, messages: [] }),
      addMessage: vi.fn(),
      addMessages: vi.fn().mockResolvedValue(undefined),
      upsertUserMessage: vi.fn().mockResolvedValue(undefined),
      completeTurn,
      triggerCompression,
      clearHistory: vi.fn(),
    };
    const config = createConfig(true);
    config.conversation = conversation;
    const runtime = createAiReplyHandler(config);
    runtimes.push(runtime);

    await runtime.handler(createContext(api, 1, 11, "sample first"), vi.fn());

    await vi.waitFor(() =>
      expect(completeTurn).toHaveBeenCalledWith(CHAT_ID, "telegram:11:user", undefined),
    );
    expect(triggerCompression).toHaveBeenCalledWith(CHAT_ID);
  });

  it("retries transient failures while finalizing group persistence", async () => {
    streamTextMock.mockImplementationOnce(() => streamResult(Promise.resolve("# Final")));
    const { api } = createApi();
    const completeTurn = vi
      .fn()
      .mockRejectedValueOnce(new Error("temporary database failure"))
      .mockRejectedValueOnce(new Error("temporary database failure"))
      .mockResolvedValue(undefined);
    const triggerCompression = vi.fn().mockResolvedValue(undefined);
    const conversation: ConversationCallbacks = {
      getHistory: vi.fn().mockResolvedValue({ summary: null, messages: [] }),
      addMessage: vi.fn(),
      addMessages: vi.fn().mockResolvedValue(undefined),
      upsertUserMessage: vi.fn().mockResolvedValue({ id: 101 }),
      completeTurn,
      triggerCompression,
      clearHistory: vi.fn(),
    };
    const config = createConfig(true);
    config.conversation = conversation;
    const runtime = createAiReplyHandler(config);
    runtimes.push(runtime);

    await runtime.handler(createContext(api, 1, 11, "sample first"), vi.fn());

    await vi.waitFor(() => expect(completeTurn).toHaveBeenCalledTimes(3));
    expect(triggerCompression).toHaveBeenCalledWith(CHAT_ID);
  });

  it("releases ingress while a queued notice is still being sent", async () => {
    const firstReply = deferred<string>();
    const noticeStarted = deferred<void>();
    const finishNotice = deferred<void>();
    streamTextMock
      .mockImplementationOnce(() => streamResult(firstReply.promise))
      .mockImplementationOnce(() => streamResult(Promise.resolve("# Queued final")));
    const { api, sendMessage } = createApi();
    sendMessage.mockImplementationOnce(async (_chatId, text) => {
      noticeStarted.resolve(undefined);
      await finishNotice.promise;
      return sentMessage(202, text);
    });
    const ingressLock = new AiIngressLock();
    const runtime = createAiReplyHandler(createConfig(true), { ingressLock });
    runtimes.push(runtime);
    const activeContext = createContext(api, 1, 11, "sample active");
    const queuedContext = createContext(api, 2, 12, "sample queued");

    await ingressLock.runAdmittedMessage(activeContext, CHAT_ID, USER_ID, async () => {
      await runtime.handler(activeContext, vi.fn());
    });
    await vi.waitFor(() => expect(streamTextMock).toHaveBeenCalledOnce());
    const queuedAdmission = ingressLock.runAdmittedMessage(
      queuedContext,
      CHAT_ID,
      USER_ID,
      async () => {
        await runtime.handler(queuedContext, vi.fn());
      },
    );
    await noticeStarted.promise;

    const mutation = vi.fn();
    const chatMutation = ingressLock.runChatMutation(CHAT_ID, async () => mutation());
    try {
      await vi.waitFor(() => expect(mutation).toHaveBeenCalledOnce());
    } finally {
      finishNotice.resolve(undefined);
      firstReply.resolve("# Active final");
      await Promise.allSettled([queuedAdmission, chatMutation]);
    }
  });

  it("starts a queued model turn without waiting for its slow queue notice", async () => {
    const firstReply = deferred<string>();
    const noticeStarted = deferred<void>();
    const finishNotice = deferred<void>();
    streamTextMock
      .mockImplementationOnce(() => streamResult(firstReply.promise))
      .mockImplementationOnce(() => streamResult(Promise.resolve("# Queued final")));
    const { api, sendMessage } = createApi();
    sendMessage.mockImplementationOnce(async (_chatId, text) => {
      noticeStarted.resolve(undefined);
      await finishNotice.promise;
      return sentMessage(202, text);
    });
    const config = createConfig(true);
    config.executionConfig!.maxConcurrentReplies = 1;
    const runtime = createAiReplyHandler(config);
    runtimes.push(runtime);

    try {
      await runtime.handler(createContext(api, 1, 11, "sample active"), vi.fn());
      await vi.waitFor(() => expect(streamTextMock).toHaveBeenCalledOnce());
      await runtime.handler(createContext(api, 2, 12, "sample queued"), vi.fn());
      await noticeStarted.promise;

      firstReply.resolve("# Active final");

      await vi.waitFor(() => expect(streamTextMock).toHaveBeenCalledTimes(2));
    } finally {
      firstReply.resolve("# Active final");
      finishNotice.resolve(undefined);
    }
  });

  it("detaches a long active turn, queues the next turn, and edits its notice in place", async () => {
    const firstReply = deferred<string>();
    const longReply = `# Active reply\n${"x".repeat(3500)}`;
    streamTextMock
      .mockImplementationOnce(() => streamResult(firstReply.promise))
      .mockImplementationOnce(() => streamResult(Promise.resolve("# Queued final")));
    const onLog = vi.fn();
    const { api, sendMessage, sendRichMessage, editMessageText } = createApi();
    const runtime = createAiReplyHandler(createConfig(true, onLog));
    runtimes.push(runtime);
    const firstContext = createContext(api, 1, 11, "sample first");
    const secondContext = createContext(api, 2, 12, "sample second");

    await runtime.handler(firstContext, vi.fn());
    await vi.waitFor(() => expect(streamTextMock).toHaveBeenCalledTimes(1));

    await runtime.handler(secondContext, vi.fn());

    expect(streamTextMock).toHaveBeenCalledTimes(1);
    expect(sendMessage).toHaveBeenCalledOnce();
    expect(sendMessage.mock.calls[0]?.[1]).toBe(QUEUE_NOTICE);
    expect(sendMessage.mock.calls[0]?.[2]).toMatchObject({
      reply_parameters: { message_id: 12 },
    });
    expect(secondContext.waiting_message?.message_id).toBe(202);
    expect(editMessageText).not.toHaveBeenCalled();

    firstReply.resolve(longReply);

    await vi.waitFor(() => expect(editMessageText).toHaveBeenCalledOnce());
    expect(editMessageText).toHaveBeenCalledWith(CHAT_ID, 202, "<b>Queued final</b>", {
      parse_mode: "HTML",
    });
    expect(sendMessage).toHaveBeenCalledOnce();
    expect(
      sendRichMessage.mock.calls.some(([, input]) => input.markdown === "# Queued final"),
    ).toBe(false);
    expect(secondContext.waiting_message).toBeUndefined();
    await vi.waitFor(() =>
      expect(onLog.mock.calls.filter(([entry]) => entry.message === "AI reply sent")).toHaveLength(
        2,
      ),
    );
  });

  it("does not send a placeholder when the queue notice is disabled", async () => {
    const firstReply = deferred<string>();
    streamTextMock
      .mockImplementationOnce(() => streamResult(firstReply.promise))
      .mockImplementationOnce(() => streamResult(Promise.resolve("# Queued final")));
    const onLog = vi.fn();
    const { api, sendMessage, sendRichMessage, editMessageText } = createApi();
    const runtime = createAiReplyHandler(createConfig(false, onLog));
    runtimes.push(runtime);

    await runtime.handler(createContext(api, 1, 11, "sample first"), vi.fn());
    await vi.waitFor(() => expect(streamTextMock).toHaveBeenCalledTimes(1));
    await runtime.handler(createContext(api, 2, 12, "sample second"), vi.fn());

    expect(streamTextMock).toHaveBeenCalledTimes(1);
    expect(sendMessage).not.toHaveBeenCalled();
    expect(editMessageText).not.toHaveBeenCalled();

    firstReply.resolve("# Active final");

    await vi.waitFor(() =>
      expect(onLog.mock.calls.filter(([entry]) => entry.message === "AI reply sent")).toHaveLength(
        2,
      ),
    );
    expect(sendMessage).not.toHaveBeenCalled();
    expect(editMessageText).not.toHaveBeenCalled();
    expect(sendRichMessage).toHaveBeenCalledTimes(2);
  });

  it("keeps multiple queued placeholders owned by their original messages", async () => {
    const activeReply = deferred<string>();
    const secondReply = deferred<string>();
    streamTextMock
      .mockImplementationOnce(() => streamResult(activeReply.promise))
      .mockImplementationOnce(() => streamResult(secondReply.promise))
      .mockImplementationOnce(() => streamResult(Promise.resolve("# C final")));
    const onLog = vi.fn();
    const { api, sendMessage, editMessageText, deleteMessages } = createApi();
    const runtime = createAiReplyHandler(createConfig(true, onLog));
    runtimes.push(runtime);
    // Distinct users so the queued turns stay separate instead of coalescing.
    const activeContext = createContext(api, 1, 11, "sample A");
    const secondContext = createContext(api, 2, 12, "sample B", USER_ID + 1);
    const thirdContext = createContext(api, 3, 13, "sample C", USER_ID + 2);

    await runtime.handler(activeContext, vi.fn());
    await vi.waitFor(() => expect(streamTextMock).toHaveBeenCalledTimes(1));
    await runtime.handler(secondContext, vi.fn());
    await runtime.handler(thirdContext, vi.fn());

    expect(sendMessage.mock.calls.map(([, text]) => text)).toEqual([QUEUE_NOTICE, QUEUE_NOTICE]);
    expect(sendMessage.mock.calls.map(([, , options]) => options?.reply_parameters)).toEqual([
      { message_id: 12 },
      { message_id: 13 },
    ]);
    expect(secondContext.waiting_message?.message_id).toBe(202);
    expect(thirdContext.waiting_message?.message_id).toBe(203);

    activeReply.resolve("# A final");
    await vi.waitFor(() => expect(streamTextMock).toHaveBeenCalledTimes(2));
    expect(editMessageText).not.toHaveBeenCalled();

    secondReply.resolve("# B final");

    await vi.waitFor(() => expect(editMessageText).toHaveBeenCalledTimes(2));
    expect(editMessageText.mock.calls).toEqual([
      [CHAT_ID, 202, "<b>B final</b>", { parse_mode: "HTML" }],
      [CHAT_ID, 203, "<b>C final</b>", { parse_mode: "HTML" }],
    ]);
    expect(secondContext.waiting_message).toBeUndefined();
    expect(thirdContext.waiting_message).toBeUndefined();
    expect(deleteMessages).not.toHaveBeenCalled();
    await vi.waitFor(() =>
      expect(onLog.mock.calls.filter(([entry]) => entry.message === "AI reply sent")).toHaveLength(
        3,
      ),
    );
  });

  it("deletes a cancelled queued placeholder without starting its model turn", async () => {
    const activeReply = deferred<string>();
    streamTextMock
      .mockImplementationOnce(() => streamResult(activeReply.promise))
      .mockImplementationOnce(() => streamResult(Promise.resolve("must not run")));
    const onLog = vi.fn();
    const { api, deleteMessages } = createApi();
    const runtime = createAiReplyHandler(createConfig(true, onLog));
    runtimes.push(runtime);
    const queuedContext = createContext(api, 2, 12, "sample queued");

    await runtime.handler(createContext(api, 1, 11, "sample active"), vi.fn());
    await vi.waitFor(() => expect(streamTextMock).toHaveBeenCalledTimes(1));
    await runtime.handler(queuedContext, vi.fn());
    expect(queuedContext.waiting_message?.message_id).toBe(202);

    runtime.setAiEnabled(false);

    await vi.waitFor(() => expect(deleteMessages).toHaveBeenCalledWith(CHAT_ID, [202], undefined));
    expect(queuedContext.waiting_message).toBeUndefined();
    expect(streamTextMock).toHaveBeenCalledTimes(1);

    activeReply.resolve("# Cancelled active final");
    await vi.waitFor(() =>
      expect(onLog).toHaveBeenCalledWith(
        expect.objectContaining({ message: "AI disabled mid-reply, dropping pending sends" }),
      ),
    );
  });

  it("drains a delayed queue notice and its cancellation cleanup before destroy resolves", async () => {
    const activeReply = deferred<string>();
    const noticeStarted = deferred<void>();
    const finishNotice = deferred<void>();
    streamTextMock.mockImplementationOnce(() => streamResult(activeReply.promise));
    const { api, sendMessage, deleteMessages } = createApi();
    sendMessage.mockImplementationOnce(async (_chatId, text) => {
      noticeStarted.resolve(undefined);
      await finishNotice.promise;
      return sentMessage(202, text);
    });
    const runtime = createAiReplyHandler(createConfig(true));
    runtimes.push(runtime);
    let destroyPromise: Promise<void> | undefined;

    try {
      await runtime.handler(createContext(api, 1, 11, "sample active"), vi.fn());
      await vi.waitFor(() => expect(streamTextMock).toHaveBeenCalledOnce());
      await runtime.handler(createContext(api, 2, 12, "sample queued"), vi.fn());
      await noticeStarted.promise;

      destroyPromise = runtime.destroy();
      let destroySettled = false;
      void destroyPromise.then(() => {
        destroySettled = true;
      });
      activeReply.resolve("# Cancelled active final");
      await vi.waitFor(() => expect(runtime.state.getAiExecutionStats().tracked).toBe(0));

      expect(destroySettled).toBe(false);
      expect(deleteMessages).not.toHaveBeenCalled();

      finishNotice.resolve(undefined);
      await destroyPromise;

      expect(deleteMessages).toHaveBeenCalledWith(CHAT_ID, [202], undefined);
    } finally {
      activeReply.resolve("# Cancelled active final");
      finishNotice.resolve(undefined);
      if (destroyPromise) await Promise.allSettled([destroyPromise]);
    }
  });

  it.each([
    ["Chat", (runtime: ReturnType<typeof createAiReplyHandler>) => runtime.cancelChatRuns(CHAT_ID)],
    ["User", (runtime: ReturnType<typeof createAiReplyHandler>) => runtime.cancelUserRuns(USER_ID)],
  ])(
    "drains a delayed queue notice before a scoped %s cancellation resolves",
    async (_scope, cancel) => {
      const activeReply = deferred<string>();
      const noticeStarted = deferred<void>();
      const finishNotice = deferred<void>();
      streamTextMock.mockImplementationOnce(() => streamResult(activeReply.promise));
      const { api, sendMessage, deleteMessages } = createApi();
      sendMessage.mockImplementationOnce(async (_chatId, text) => {
        noticeStarted.resolve(undefined);
        await finishNotice.promise;
        return sentMessage(202, text);
      });
      const config = createConfig(true);
      config.executionConfig!.maxConcurrentReplies = 1;
      const runtime = createAiReplyHandler(config);
      runtimes.push(runtime);
      let cancelPromise: Promise<number> | undefined;

      try {
        await runtime.handler(createContext(api, 1, 11, "sample active"), vi.fn());
        await vi.waitFor(() => expect(streamTextMock).toHaveBeenCalledOnce());
        await runtime.handler(createContext(api, 2, 12, "sample queued"), vi.fn());
        await noticeStarted.promise;

        let cancelSettled = false;
        cancelPromise = cancel(runtime);
        void cancelPromise.then(() => {
          cancelSettled = true;
        });
        activeReply.resolve("# Cancelled active final");
        await vi.waitFor(() => expect(runtime.state.getAiExecutionStats().tracked).toBe(0));
        await new Promise<void>((resolve) => setTimeout(resolve, 0));

        expect(cancelSettled).toBe(false);
        expect(deleteMessages).not.toHaveBeenCalled();

        finishNotice.resolve(undefined);
        await cancelPromise;

        expect(deleteMessages).toHaveBeenCalledWith(CHAT_ID, [202], undefined);
      } finally {
        activeReply.resolve("# Cancelled active final");
        finishNotice.resolve(undefined);
        if (cancelPromise) await Promise.allSettled([cancelPromise]);
      }
    },
  );

  it("drains a delayed queue-full reply before destroy resolves", async () => {
    const activeReply = deferred<string>();
    const busyReplyStarted = deferred<void>();
    const finishBusyReply = deferred<void>();
    streamTextMock.mockImplementationOnce(() => streamResult(activeReply.promise));
    const { api, sendMessage } = createApi();
    sendMessage.mockImplementationOnce(async (_chatId, text) => {
      busyReplyStarted.resolve(undefined);
      await finishBusyReply.promise;
      return sentMessage(202, text);
    });
    const config = createConfig(false);
    config.executionConfig!.maxConcurrentReplies = 1;
    const runtime = createAiReplyHandler(config);
    runtimes.push(runtime);
    let destroyPromise: Promise<void> | undefined;

    try {
      await runtime.handler(createContext(api, 1, 11, "sample active"), vi.fn());
      await vi.waitFor(() => expect(streamTextMock).toHaveBeenCalledOnce());
      // Distinct users so every message queues separately and actually fills the queue.
      for (let index = 0; index <= 100; index++) {
        await runtime.handler(
          createContext(api, index + 2, index + 12, `sample queued ${index}`, USER_ID + 1 + index),
          vi.fn(),
        );
      }
      await busyReplyStarted.promise;

      destroyPromise = runtime.destroy();
      let destroySettled = false;
      void destroyPromise.then(() => {
        destroySettled = true;
      });
      activeReply.resolve("# Cancelled active final");
      await vi.waitFor(() => expect(runtime.state.getAiExecutionStats().tracked).toBe(0));

      expect(destroySettled).toBe(false);

      finishBusyReply.resolve(undefined);
      await destroyPromise;
    } finally {
      activeReply.resolve("# Cancelled active final");
      finishBusyReply.resolve(undefined);
      if (destroyPromise) await Promise.allSettled([destroyPromise]);
    }
  });

  it("clears cached group context with Chat-scoped cancellation", async () => {
    streamTextMock.mockImplementationOnce(() => streamResult(Promise.resolve("# Final")));
    const onLog = vi.fn();
    const { api } = createApi();
    const runtime = createAiReplyHandler(createConfig(true, onLog));
    runtimes.push(runtime);

    await runtime.handler(createContext(api, 1, 11, "sample active"), vi.fn());
    expect(runtime.state.getActiveGroupCount()).toBe(1);

    await runtime.cancelChatRuns(CHAT_ID);

    expect(runtime.state.getActiveGroupCount()).toBe(0);
  });

  it("captures an earlier continuation before clearing the Chat", async () => {
    const runtime = createAiReplyHandler(createConfig(true));
    runtimes.push(runtime);
    const runWithExecution = runtime.state.getContinueChatConfig(CHAT_ID).runWithExecution!;
    const started = deferred<void>();
    const events: string[] = [];
    const continuation = runWithExecution(
      { chatId: CHAT_ID, userId: USER_ID },
      async ({ signal }) => {
        events.push("continuation:start");
        started.resolve(undefined);
        await new Promise<void>((resolve) =>
          signal.addEventListener("abort", () => resolve(), { once: true }),
        );
        events.push("continuation:aborted");
        return "old turn";
      },
    );
    await started.promise;

    await runtime.runChatMutation(CHAT_ID, async () => {
      events.push("clear:cancel");
      expect(await runtime.cancelChatRuns(CHAT_ID)).toBe(1);
      events.push("clear:history");
    });

    await expect(continuation).rejects.toBeInstanceOf(AiRunCancelledError);
    expect(events).toEqual([
      "continuation:start",
      "clear:cancel",
      "continuation:aborted",
      "clear:history",
    ]);
  });

  it("admits a later continuation only after clearHistory completes", async () => {
    const runtime = createAiReplyHandler(createConfig(true));
    runtimes.push(runtime);
    const runWithExecution = runtime.state.getContinueChatConfig(CHAT_ID).runWithExecution!;
    const clearStarted = deferred<void>();
    const finishClear = deferred<void>();
    let historyVersion = "old";
    const clearHistory = vi.fn(async () => {
      clearStarted.resolve(undefined);
      await finishClear.promise;
      historyVersion = "new";
    });
    const clear = runtime.runChatMutation(CHAT_ID, async () => {
      await runtime.cancelChatRuns(CHAT_ID);
      await clearHistory();
    });
    await clearStarted.promise;

    const operation = vi.fn(async () => historyVersion);
    const continuation = runWithExecution({ chatId: CHAT_ID }, operation);
    await Promise.resolve();
    expect(operation).not.toHaveBeenCalled();
    expect(runtime.state.getAiExecutionStats().tracked).toBe(0);

    finishClear.resolve(undefined);
    await clear;
    await expect(continuation).resolves.toBe("new");
    expect(operation).toHaveBeenCalledOnce();
  });

  it("admits a personalized continuation only after its User privacy mutation", async () => {
    const runtime = createAiReplyHandler(createConfig(true));
    runtimes.push(runtime);
    const runWithExecution = runtime.state.getContinueChatConfig(CHAT_ID).runWithExecution!;
    const mutationStarted = deferred<void>();
    const finishMutation = deferred<void>();
    let privacyVersion = "old";
    const mutation = runtime.runUserMutation(USER_ID, async () => {
      await runtime.cancelUserRuns(USER_ID);
      mutationStarted.resolve(undefined);
      await finishMutation.promise;
      privacyVersion = "new";
    });
    await mutationStarted.promise;

    const operation = vi.fn(async () => privacyVersion);
    const continuation = runWithExecution({ chatId: CHAT_ID, userId: USER_ID }, operation);
    await Promise.resolve();
    expect(operation).not.toHaveBeenCalled();
    expect(runtime.state.getAiExecutionStats().tracked).toBe(0);

    finishMutation.resolve(undefined);
    await mutation;
    await expect(continuation).resolves.toBe("new");
    expect(operation).toHaveBeenCalledOnce();
  });
});

const PRIVATE_CHAT_ID = USER_ID;

function createPrivateContext(
  api: Api,
  updateId: number,
  messageId: number,
  text: string,
): BotContext {
  const update = {
    update_id: updateId,
    message: {
      message_id: messageId,
      date: 0,
      chat: { id: PRIVATE_CHAT_ID, type: "private", first_name: "Tester" },
      from: { id: USER_ID, is_bot: false, first_name: "Tester" },
      text,
      entities: [],
    },
  } as Update;
  const me = { id: 99, is_bot: true, first_name: "Ai", username: "sample_bot" } as UserFromGetMe;
  return new WrapperContext(update, api, me) as BotContext;
}

describe("AI reply turn coalescing", () => {
  function createConversation() {
    let nextRowId = 100;
    const rowIds = new Map<string, number>();
    const completeTurn = vi.fn().mockResolvedValue(undefined);
    const completeTurns = vi.fn().mockResolvedValue(undefined);
    const addMessages = vi
      .fn<NonNullable<ConversationCallbacks["addMessages"]>>()
      .mockResolvedValue(undefined);
    const conversation: ConversationCallbacks = {
      getHistory: vi.fn().mockResolvedValue({ summary: null, messages: [] }),
      addMessage: vi.fn(),
      addMessages,
      upsertUserMessage: vi.fn(async (message) => {
        let id = rowIds.get(message.sourceKey);
        if (id === undefined) {
          id = nextRowId++;
          rowIds.set(message.sourceKey, id);
        }
        return { id };
      }),
      completeTurn,
      completeTurns,
      triggerCompression: vi.fn(),
      clearHistory: vi.fn(),
    };
    return { conversation, completeTurn, completeTurns, addMessages };
  }

  it("merges a same-user text follow-up into the queued run", async () => {
    const activeReply = deferred<string>();
    streamTextMock
      .mockImplementationOnce(() => streamResult(activeReply.promise))
      .mockImplementationOnce(() => streamResult(Promise.resolve("# Merged final")));
    const onLog = vi.fn();
    const { api, sendMessage } = createApi();
    const { conversation, completeTurns } = createConversation();
    const config = createConfig(true, onLog);
    config.conversation = conversation;
    const runtime = createAiReplyHandler(config);
    runtimes.push(runtime);

    await runtime.handler(createContext(api, 1, 11, "sample first"), vi.fn());
    await vi.waitFor(() => expect(streamTextMock).toHaveBeenCalledTimes(1));
    await runtime.handler(createContext(api, 2, 12, "sample queued owner"), vi.fn());
    await runtime.handler(createContext(api, 3, 13, "sample follow up"), vi.fn());

    expect(
      onLog.mock.calls.some(([entry]) => entry.message === "AI reply coalesced into queued turn"),
    ).toBe(true);
    // Only the batch owner posts a queue notice.
    expect(sendMessage.mock.calls.filter(([, text]) => text === QUEUE_NOTICE)).toHaveLength(1);

    activeReply.resolve("# Active final");

    await vi.waitFor(() =>
      expect(onLog.mock.calls.filter(([entry]) => entry.message === "AI reply sent")).toHaveLength(
        2,
      ),
    );
    // One model call answers the whole burst.
    expect(streamTextMock).toHaveBeenCalledTimes(2);
    const mergedRequest = JSON.stringify(streamTextMock.mock.calls[1]?.[0]?.messages);
    expect(mergedRequest).toContain("sample queued owner");
    expect(mergedRequest).toContain("sample follow up");
    // Both ingress rows are finalized by the owning run.
    await vi.waitFor(() => {
      expect(completeTurns).toHaveBeenCalledWith(
        CHAT_ID,
        ["telegram:12:user", "telegram:13:user"],
        101,
      );
    });
  });

  it("persists a merged group reply anchor outside the user-authored projection", async () => {
    const activeReply = deferred<string>();
    streamTextMock
      .mockImplementationOnce(() => streamResult(activeReply.promise))
      .mockImplementationOnce(() => streamResult(Promise.resolve("# Merged final")));
    const { api } = createApi();
    const { conversation } = createConversation();
    const config = createConfig(true);
    config.conversation = conversation;
    const runtime = createAiReplyHandler(config);
    runtimes.push(runtime);

    try {
      await runtime.handler(createContext(api, 1, 11, "sample active"), vi.fn());
      await vi.waitFor(() => expect(streamTextMock).toHaveBeenCalledTimes(1));
      await runtime.handler(createContext(api, 2, 12, "sample queued owner"), vi.fn());
      const followUp = createContext(api, 3, 13, "sample follow up");
      followUp.reply_to_message = {
        message_id: 10,
        date: 0,
        chat: { id: CHAT_ID, type: "supergroup", title: "Test group" },
        from: { id: 99, is_bot: true, first_name: "Ai" },
        text: "assistant-only context",
      } as Message;
      await runtime.handler(followUp, vi.fn());

      const upsertUserMessage = vi.mocked(conversation.upsertUserMessage!);
      const persistedFollowUp = upsertUserMessage.mock.calls.find(
        ([message]) => message.sourceKey === "telegram:13:user",
      )?.[0];
      expect(persistedFollowUp?.content).toContain("assistant-only context");
      expect(persistedFollowUp?.userAuthoredContent).toBe("sample follow up");
    } finally {
      activeReply.resolve("# Active final");
    }
  });

  it("finalizes a merged turn before the next queued turn starts", async () => {
    const activeReply = deferred<string>();
    const finalizationStarted = deferred<void>();
    const finishFinalization = deferred<void>();
    const order: string[] = [];
    streamTextMock
      .mockImplementationOnce(() => streamResult(activeReply.promise))
      .mockImplementationOnce(() => streamResult(Promise.resolve("# Merged final")))
      .mockImplementationOnce(() => {
        order.push("next-model-started");
        return streamResult(Promise.resolve("# Next final"));
      });
    const { api } = createApi();
    const { conversation, completeTurns } = createConversation();
    completeTurns.mockImplementation(async (_chatId, sourceKeys) => {
      if (!sourceKeys.includes("telegram:12:user")) return;
      order.push("finalization-started");
      finalizationStarted.resolve();
      await finishFinalization.promise;
      order.push("finalization-finished");
    });
    const config = createConfig(true);
    config.conversation = conversation;
    const runtime = createAiReplyHandler(config);
    runtimes.push(runtime);

    try {
      await runtime.handler(createContext(api, 1, 11, "sample active"), vi.fn());
      await vi.waitFor(() => expect(streamTextMock).toHaveBeenCalledTimes(1));
      await runtime.handler(createContext(api, 2, 12, "sample queued owner"), vi.fn());
      await runtime.handler(createContext(api, 3, 13, "sample follow up"), vi.fn());
      await runtime.handler(createContext(api, 4, 14, "sample next turn", USER_ID + 1), vi.fn());

      activeReply.resolve("# Active final");
      await finalizationStarted.promise;
      await new Promise<void>((resolve) => setImmediate(resolve));

      expect(order).toEqual(["finalization-started"]);

      finishFinalization.resolve();
      await vi.waitFor(() => expect(streamTextMock).toHaveBeenCalledTimes(3));
      expect(order).toEqual([
        "finalization-started",
        "finalization-finished",
        "next-model-started",
      ]);
    } finally {
      activeReply.resolve("# Active final");
      finishFinalization.resolve();
    }
  });

  it("keeps persisted group turns separate without an atomic finalization callback", async () => {
    const activeReply = deferred<string>();
    streamTextMock
      .mockImplementationOnce(() => streamResult(activeReply.promise))
      .mockImplementationOnce(() => streamResult(Promise.resolve("# Second final")))
      .mockImplementationOnce(() => streamResult(Promise.resolve("# Third final")));
    const onLog = vi.fn();
    const { api, sendMessage } = createApi();
    const { conversation } = createConversation();
    delete conversation.completeTurns;
    const config = createConfig(true, onLog);
    config.conversation = conversation;
    const runtime = createAiReplyHandler(config);
    runtimes.push(runtime);

    try {
      await runtime.handler(createContext(api, 1, 11, "sample active"), vi.fn());
      await vi.waitFor(() => expect(streamTextMock).toHaveBeenCalledTimes(1));
      await runtime.handler(createContext(api, 2, 12, "sample queued owner"), vi.fn());
      await runtime.handler(createContext(api, 3, 13, "sample follow up"), vi.fn());

      expect(sendMessage.mock.calls.filter(([, text]) => text === QUEUE_NOTICE)).toHaveLength(2);
      expect(
        onLog.mock.calls.some(([entry]) => entry.message === "AI reply coalesced into queued turn"),
      ).toBe(false);

      activeReply.resolve("# Active final");
      await vi.waitFor(() => expect(streamTextMock).toHaveBeenCalledTimes(3));
    } finally {
      activeReply.resolve("# Active final");
    }
  });

  it("keeps persisted group turns separate without stable ingress row IDs", async () => {
    const activeReply = deferred<string>();
    streamTextMock
      .mockImplementationOnce(() => streamResult(activeReply.promise))
      .mockImplementationOnce(() => streamResult(Promise.resolve("# Second final")))
      .mockImplementationOnce(() => streamResult(Promise.resolve("# Third final")));
    const onLog = vi.fn();
    const { api } = createApi();
    const { conversation } = createConversation();
    conversation.upsertUserMessage = vi.fn().mockResolvedValue(undefined);
    const config = createConfig(true, onLog);
    config.conversation = conversation;
    const runtime = createAiReplyHandler(config);
    runtimes.push(runtime);

    try {
      await runtime.handler(createContext(api, 1, 11, "sample active"), vi.fn());
      await vi.waitFor(() => expect(streamTextMock).toHaveBeenCalledTimes(1));
      await runtime.handler(createContext(api, 2, 12, "sample queued owner"), vi.fn());
      await runtime.handler(createContext(api, 3, 13, "sample follow up"), vi.fn());

      expect(
        onLog.mock.calls.some(([entry]) => entry.message === "AI reply coalesced into queued turn"),
      ).toBe(false);

      activeReply.resolve("# Active final");
      await vi.waitFor(() => expect(streamTextMock).toHaveBeenCalledTimes(3));
    } finally {
      activeReply.resolve("# Active final");
    }
  });

  it("finalizes merged turns when the queued owner is cancelled before starting", async () => {
    const activeReply = deferred<string>();
    streamTextMock.mockImplementationOnce(() => streamResult(activeReply.promise));
    const { api } = createApi();
    const { conversation, completeTurns } = createConversation();
    const config = createConfig(true);
    config.conversation = conversation;
    const runtime = createAiReplyHandler(config);
    runtimes.push(runtime);

    try {
      await runtime.handler(createContext(api, 1, 11, "sample first"), vi.fn());
      await vi.waitFor(() => expect(streamTextMock).toHaveBeenCalledTimes(1));
      await runtime.handler(createContext(api, 2, 12, "sample queued owner"), vi.fn());
      await runtime.handler(createContext(api, 3, 13, "sample follow up"), vi.fn());

      // Release the active run concurrently so chat cancellation can drain it.
      const cancelPromise = runtime.cancelChatRuns(CHAT_ID);
      activeReply.resolve("# Cancelled active final");
      await cancelPromise;

      await vi.waitFor(() => {
        expect(completeTurns).toHaveBeenCalledWith(
          CHAT_ID,
          ["telegram:12:user", "telegram:13:user"],
          101,
        );
      });
      expect(streamTextMock).toHaveBeenCalledTimes(1);
    } finally {
      activeReply.resolve("# Cancelled active final");
    }
  });

  it("persists merged private follow-ups when the queued owner is cancelled before starting", async () => {
    const activeReply = deferred<string>();
    streamTextMock.mockImplementationOnce(() => streamResult(activeReply.promise));
    const { api } = createApi();
    const { conversation, addMessages } = createConversation();
    addMessages.mockRejectedValueOnce(new Error("temporary database failure"));
    const config = createConfig(true);
    config.conversation = conversation;
    config.privateChatWhitelist = [USER_ID];
    const runtime = createAiReplyHandler(config);
    runtimes.push(runtime);

    try {
      await runtime.handler(createPrivateContext(api, 1, 11, "first"), vi.fn());
      await vi.waitFor(() => expect(streamTextMock).toHaveBeenCalledTimes(1));
      await runtime.handler(createPrivateContext(api, 2, 12, "queued owner"), vi.fn());
      await runtime.handler(createPrivateContext(api, 3, 13, "follow up"), vi.fn());

      const cancelPromise = runtime.cancelChatRuns(PRIVATE_CHAT_ID);
      activeReply.resolve("# Cancelled active final");
      await cancelPromise;

      expect(addMessages).toHaveBeenCalledTimes(2);
      expect(addMessages.mock.calls[1]?.[0].map((row) => row.sourceKey)).toContain(
        "telegram:13:user",
      );
      expect(streamTextMock).toHaveBeenCalledTimes(1);
    } finally {
      activeReply.resolve("# Cancelled active final");
    }
  });

  it("does not merge private turns admitted under different privacy modes", async () => {
    const activeReply = deferred<string>();
    streamTextMock
      .mockImplementationOnce(() => streamResult(activeReply.promise))
      .mockImplementationOnce(() => streamResult(Promise.resolve("# Off-mode final")));
    const onLog = vi.fn();
    const { api, sendMessage } = createApi();
    const { conversation } = createConversation();
    let mode: UserPrivacyMode = "normal";
    const config = createConfig(true, onLog);
    config.conversation = conversation;
    config.privateChatWhitelist = [USER_ID];
    config.privacy = {
      getMode: vi.fn(async () => mode),
      runExclusive: vi.fn(async (_userId, operation) => operation()),
      setMode: vi.fn(),
      forget: vi.fn(),
    } as UserPrivacyCallbacks;
    const runtime = createAiReplyHandler(config);
    runtimes.push(runtime);

    try {
      await runtime.handler(createPrivateContext(api, 1, 11, "first"), vi.fn());
      await vi.waitFor(() => expect(streamTextMock).toHaveBeenCalledTimes(1));
      await runtime.handler(createPrivateContext(api, 2, 12, "queued owner"), vi.fn());
      mode = "off";
      await runtime.handler(createPrivateContext(api, 3, 13, "off-mode follow up"), vi.fn());

      expect(sendMessage.mock.calls.filter(([, text]) => text === QUEUE_NOTICE)).toHaveLength(2);
      expect(
        onLog.mock.calls.some(([entry]) => entry.message === "AI reply coalesced into queued turn"),
      ).toBe(false);

      activeReply.resolve("# Active final");
      await vi.waitFor(() => expect(streamTextMock).toHaveBeenCalledTimes(2));
      expect(JSON.stringify(streamTextMock.mock.calls[1]?.[0]?.messages)).toContain(
        "off-mode follow up",
      );
    } finally {
      activeReply.resolve("# Active final");
    }
  });

  it("does not rescue merged private messages after the privacy mode changes", async () => {
    const activeReply = deferred<string>();
    streamTextMock.mockImplementationOnce(() => streamResult(activeReply.promise));
    const { api } = createApi();
    const { conversation, addMessages } = createConversation();
    let mode: UserPrivacyMode = "normal";
    const config = createConfig(true);
    config.conversation = conversation;
    config.privateChatWhitelist = [USER_ID];
    config.privacy = {
      getMode: vi.fn(async () => mode),
      runExclusive: vi.fn(async (_userId, operation) => operation()),
      setMode: vi.fn(),
      forget: vi.fn(),
    } as UserPrivacyCallbacks;
    const runtime = createAiReplyHandler(config);
    runtimes.push(runtime);

    try {
      await runtime.handler(createPrivateContext(api, 1, 11, "first"), vi.fn());
      await vi.waitFor(() => expect(streamTextMock).toHaveBeenCalledTimes(1));
      await runtime.handler(createPrivateContext(api, 2, 12, "queued owner"), vi.fn());
      await runtime.handler(createPrivateContext(api, 3, 13, "follow up"), vi.fn());

      mode = "off";
      const cancellation = runtime.cancelChatRuns(PRIVATE_CHAT_ID);
      activeReply.resolve("# Active final");
      await cancellation;

      const saved = addMessages.mock.calls.flatMap(([rows]) => rows);
      expect(saved.map((row) => row.sourceKey)).not.toContain("telegram:13:user");
      expect(streamTextMock).toHaveBeenCalledTimes(1);
    } finally {
      activeReply.resolve("# Active final");
    }
  });

  it("does not merge follow-ups into an already running turn", async () => {
    const activeReply = deferred<string>();
    streamTextMock
      .mockImplementationOnce(() => streamResult(activeReply.promise))
      .mockImplementationOnce(() => streamResult(Promise.resolve("# Second final")));
    const onLog = vi.fn();
    const { api } = createApi();
    const runtime = createAiReplyHandler(createConfig(true, onLog));
    runtimes.push(runtime);

    await runtime.handler(createContext(api, 1, 11, "sample first"), vi.fn());
    await vi.waitFor(() => expect(streamTextMock).toHaveBeenCalledTimes(1));
    await runtime.handler(createContext(api, 2, 12, "sample second"), vi.fn());

    activeReply.resolve("# Active final");

    await vi.waitFor(() =>
      expect(onLog.mock.calls.filter(([entry]) => entry.message === "AI reply sent")).toHaveLength(
        2,
      ),
    );
    expect(streamTextMock).toHaveBeenCalledTimes(2);
    expect(
      onLog.mock.calls.some(([entry]) => entry.message === "AI reply coalesced into queued turn"),
    ).toBe(false);
  });

  it("does not merge across an intervening message in the same topic", async () => {
    const activeReply = deferred<string>();
    streamTextMock
      .mockImplementationOnce(() => streamResult(activeReply.promise))
      .mockImplementationOnce(() => streamResult(Promise.resolve("# Owner final")))
      .mockImplementationOnce(() => streamResult(Promise.resolve("# Follow-up final")));
    const onLog = vi.fn();
    const { api, sendMessage } = createApi();
    const { conversation } = createConversation();
    const config = createConfig(true, onLog);
    config.conversation = conversation;
    const runtime = createAiReplyHandler(config);
    runtimes.push(runtime);

    try {
      await runtime.handler(createContext(api, 1, 11, "sample active"), vi.fn());
      await vi.waitFor(() => expect(streamTextMock).toHaveBeenCalledTimes(1));
      await runtime.handler(createContext(api, 2, 12, "sample queued owner"), vi.fn());
      await runtime.handler(createContext(api, 3, 13, "intervening context"), vi.fn());
      await runtime.handler(createContext(api, 4, 14, "sample later follow up"), vi.fn());

      expect(sendMessage.mock.calls.filter(([, text]) => text === QUEUE_NOTICE)).toHaveLength(2);
      expect(
        onLog.mock.calls.some(([entry]) => entry.message === "AI reply coalesced into queued turn"),
      ).toBe(false);

      activeReply.resolve("# Active final");
      await vi.waitFor(() => expect(streamTextMock).toHaveBeenCalledTimes(3));
    } finally {
      activeReply.resolve("# Active final");
    }
  });

  it("persists merged private follow-ups with the owning turn", async () => {
    const activeReply = deferred<string>();
    streamTextMock
      .mockImplementationOnce(() => streamResult(activeReply.promise))
      .mockImplementationOnce(() => streamResult(Promise.resolve("# Merged final")));
    const { api } = createApi();
    const { conversation, addMessages } = createConversation();
    const config = createConfig(true);
    config.conversation = conversation;
    config.privateChatWhitelist = [USER_ID];
    const runtime = createAiReplyHandler(config);
    runtimes.push(runtime);

    await runtime.handler(createPrivateContext(api, 1, 11, "first"), vi.fn());
    await vi.waitFor(() => expect(streamTextMock).toHaveBeenCalledTimes(1));
    await runtime.handler(createPrivateContext(api, 2, 12, "queued owner"), vi.fn());
    await runtime.handler(createPrivateContext(api, 3, 13, "follow up"), vi.fn());
    activeReply.resolve("# Active final");

    await vi.waitFor(() => expect(streamTextMock).toHaveBeenCalledTimes(2));
    const mergedRequest = JSON.stringify(streamTextMock.mock.calls[1]?.[0]?.messages);
    expect(mergedRequest).toContain("queued owner");
    expect(mergedRequest).toContain("follow up");

    // Private messages are not persisted at ingress, so the owning turn must save both.
    await vi.waitFor(() => {
      const saved = addMessages.mock.calls.flatMap(([rows]) => rows);
      const userRows = saved.filter((row) => row.role === "user");
      expect(userRows.map((row) => row.sourceKey)).toEqual(
        expect.arrayContaining(["telegram:12:user", "telegram:13:user"]),
      );
    });
  });

  it("keeps reply quotes out of a merged private follow-up's user-authored projection", async () => {
    const activeReply = deferred<string>();
    streamTextMock
      .mockImplementationOnce(() => streamResult(activeReply.promise))
      .mockImplementationOnce(() => streamResult(Promise.resolve("# Merged final")));
    const { api } = createApi();
    const { conversation, addMessages } = createConversation();
    const config = createConfig(true);
    config.conversation = conversation;
    config.privateChatWhitelist = [USER_ID];
    const runtime = createAiReplyHandler(config);
    runtimes.push(runtime);

    await runtime.handler(createPrivateContext(api, 1, 11, "first"), vi.fn());
    await vi.waitFor(() => expect(streamTextMock).toHaveBeenCalledTimes(1));
    await runtime.handler(createPrivateContext(api, 2, 12, "queued owner"), vi.fn());
    const followUp = createPrivateContext(api, 3, 13, "follow up");
    followUp.reply_to_message = {
      message_id: 10,
      date: 0,
      chat: { id: PRIVATE_CHAT_ID, type: "private", first_name: "Tester" },
      from: { id: 99, is_bot: true, first_name: "Ai" },
      text: "assistant-only context",
    } as Message;
    await runtime.handler(followUp, vi.fn());
    activeReply.resolve("# Active final");

    await vi.waitFor(() => expect(streamTextMock).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => {
      const saved = addMessages.mock.calls.flatMap(([rows]) => rows);
      const followUpRow = saved.find((row) => row.sourceKey === "telegram:13:user");
      expect(followUpRow?.content).toContain("assistant-only context");
      expect(followUpRow?.userAuthoredContent).toBe("follow up");
    });
  });

  it("does not merge a text reply to media because it needs the reply attachment pipeline", async () => {
    const activeReply = deferred<string>();
    streamTextMock
      .mockImplementationOnce(() => streamResult(activeReply.promise))
      .mockImplementationOnce(() => streamResult(Promise.resolve("# Second final")))
      .mockImplementationOnce(() => streamResult(Promise.resolve("# Third final")));
    const onLog = vi.fn();
    const { api, sendMessage } = createApi();
    const runtime = createAiReplyHandler(createConfig(true, onLog));
    runtimes.push(runtime);

    await runtime.handler(createContext(api, 1, 11, "sample first"), vi.fn());
    await vi.waitFor(() => expect(streamTextMock).toHaveBeenCalledTimes(1));
    await runtime.handler(createContext(api, 2, 12, "sample queued owner"), vi.fn());
    const mediaReply = createContext(api, 3, 13, "sample inspect the file");
    mediaReply.reply_to_message = {
      message_id: 10,
      date: 0,
      chat: { id: CHAT_ID, type: "supergroup", title: "Test group" },
      from: { id: USER_ID, is_bot: false, first_name: "Tester" },
      document: {
        file_id: "document-id",
        file_unique_id: "document-unique-id",
        file_name: "notes.txt",
      },
    } as Message;
    await runtime.handler(mediaReply, vi.fn());

    expect(sendMessage.mock.calls.filter(([, text]) => text === QUEUE_NOTICE)).toHaveLength(2);
    expect(
      onLog.mock.calls.some(([entry]) => entry.message === "AI reply coalesced into queued turn"),
    ).toBe(false);

    activeReply.resolve("# Active final");
    await vi.waitFor(() => expect(streamTextMock).toHaveBeenCalledTimes(3));
    expect(JSON.stringify(streamTextMock.mock.calls[2]?.[0]?.messages)).toContain("notes.txt");
  });

  it("rescues merged private follow-ups when the owning run fails", async () => {
    const activeReply = deferred<string>();
    streamTextMock
      .mockImplementationOnce(() => streamResult(activeReply.promise))
      .mockImplementationOnce(() => {
        throw new Error("model exploded");
      });
    const { api } = createApi();
    const { conversation, addMessages } = createConversation();
    const config = createConfig(true);
    config.conversation = conversation;
    config.privateChatWhitelist = [USER_ID];
    const runtime = createAiReplyHandler(config);
    runtimes.push(runtime);

    await runtime.handler(createPrivateContext(api, 1, 11, "first"), vi.fn());
    await vi.waitFor(() => expect(streamTextMock).toHaveBeenCalledTimes(1));
    await runtime.handler(createPrivateContext(api, 2, 12, "queued owner"), vi.fn());
    await runtime.handler(createPrivateContext(api, 3, 13, "follow up"), vi.fn());
    activeReply.resolve("# Active final");

    await vi.waitFor(() => expect(streamTextMock).toHaveBeenCalledTimes(2));
    // The failed turn never committed, but the drained follow-up must not vanish.
    await vi.waitFor(() => {
      const saved = addMessages.mock.calls.flatMap(([rows]) => rows);
      expect(saved.map((row) => row.sourceKey)).toContain("telegram:13:user");
    });
  });

  it("preserves long reply quotes that may be outside the history window", async () => {
    streamTextMock.mockImplementationOnce(() => streamResult(Promise.resolve("# Final")));
    const onLog = vi.fn();
    const { api } = createApi();
    const runtime = createAiReplyHandler(createConfig(true, onLog));
    runtimes.push(runtime);
    const quoted = "q".repeat(400);
    const update = {
      update_id: 1,
      message: {
        message_id: 12,
        date: 0,
        chat: { id: CHAT_ID, type: "supergroup", title: "Test group" },
        from: { id: USER_ID, is_bot: false, first_name: "Tester" },
        text: "sample what about this",
        entities: [],
        reply_to_message: {
          message_id: 11,
          date: 0,
          chat: { id: CHAT_ID, type: "supergroup", title: "Test group" },
          from: { id: 99, is_bot: true, first_name: "Ai" },
          text: quoted,
        },
      },
    } as unknown as Update;
    const me = { id: 99, is_bot: true, first_name: "Ai", username: "sample_bot" } as UserFromGetMe;
    const context = new WrapperContext(update, api, me) as BotContext;

    await runtime.handler(context, vi.fn());

    await vi.waitFor(() =>
      expect(onLog.mock.calls.filter(([entry]) => entry.message === "AI reply sent")).toHaveLength(
        1,
      ),
    );
    const request = JSON.stringify(streamTextMock.mock.calls[0]?.[0]?.messages);
    expect(request).toContain(`[回复 Ai 的消息: ${quoted}]`);
  });
});
