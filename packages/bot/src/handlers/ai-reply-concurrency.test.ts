import type { Api } from "grammy";
import type { Message, Update, UserFromGetMe } from "grammy/types";
import type { ConversationCallbacks } from "@cos-tool-bot/shared";
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

function createContext(api: Api, updateId: number, messageId: number, text: string): BotContext {
  const update = {
    update_id: updateId,
    message: {
      message_id: messageId,
      date: 0,
      chat: { id: CHAT_ID, type: "supergroup", title: "Test group" },
      from: { id: USER_ID, is_bot: false, first_name: "Tester" },
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
    await vi.waitFor(() => expect(completeTurn).toHaveBeenCalledWith(CHAT_ID, "telegram:11:user"));
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

    await vi.waitFor(() => expect(completeTurn).toHaveBeenCalledWith(CHAT_ID, "telegram:11:user"));
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
    const activeContext = createContext(api, 1, 11, "sample A");
    const secondContext = createContext(api, 2, 12, "sample B");
    const thirdContext = createContext(api, 3, 13, "sample C");

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
      for (let index = 0; index <= 100; index++) {
        await runtime.handler(
          createContext(api, index + 2, index + 12, `sample queued ${index}`),
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
