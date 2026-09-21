import type { ConversationCallbacks } from "@cos-tool-bot/shared";
import type { Api } from "grammy";
import type { Message } from "grammy/types";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { continueChat, type ContinueChatConfig } from "./continue-chat.js";

const { streamTextMock } = vi.hoisted(() => ({ streamTextMock: vi.fn() }));

vi.mock("ai", async (importOriginal) => ({
  ...(await importOriginal<typeof import("ai")>()),
  streamText: streamTextMock,
}));

const CHAT_ID = -100;

function streamResult(text: string) {
  async function* textStream() {
    yield text;
  }
  return {
    textStream: textStream(),
    text: Promise.resolve(text),
    steps: Promise.resolve([]),
    totalUsage: Promise.resolve({ inputTokens: 1, outputTokens: 1, totalTokens: 2 }),
  };
}

beforeEach(() => {
  streamTextMock.mockReset();
});

describe("continueChat cancellation after partial delivery", () => {
  it("persists delivered content when cancellation lands mid-delivery", async () => {
    streamTextMock.mockImplementationOnce(() => streamResult("第一段回复。\n\n第二段回复。"));
    let current = true;
    let nextMessageId = 201;
    const sendMessage = vi.fn(async (_chatId: number, text: string) => {
      current = false;
      return {
        message_id: nextMessageId++,
        date: 0,
        chat: { id: CHAT_ID, type: "supergroup", title: "Test group" },
        text,
      } as Message.TextMessage;
    });
    const api = {
      sendMessage,
      sendChatAction: vi.fn().mockResolvedValue(true),
    } as unknown as Api;
    const addMessages = vi.fn().mockResolvedValue(undefined);
    const triggerCompression = vi.fn().mockResolvedValue(undefined);
    const conversation = {
      getHistory: vi.fn().mockResolvedValue({ summary: null, messages: [] }),
      addMessage: vi.fn(),
      addMessages,
      triggerCompression,
      clearHistory: vi.fn(),
    } as unknown as ConversationCallbacks;
    const runWithExecution: NonNullable<ContinueChatConfig["runWithExecution"]> = (
      _scope,
      operation,
    ) => operation({ signal: new AbortController().signal, isCurrent: () => current });
    const config = {
      systemPrompt: "system",
      resolveSelection: () => ({ model: {} as never, modelId: "model-a", providerId: "p" }),
      messageConfig: {
        replyMode: "segment",
        richMessageEnabled: false,
        autoSplitThreshold: 10,
        splitDelayMs: 0,
      },
      conversation,
      pendingActions: {},
      recentBotMessageIds: new Map<number, number[]>(),
      moodState: new Map(),
      runWithExecution,
    } as unknown as ContinueChatConfig;

    const delivered = await continueChat(api, config, {
      chatId: CHAT_ID,
      eventDescription: "timer fired",
      requireDelivery: true,
    });

    expect(delivered).toBe(true);
    expect(sendMessage).toHaveBeenCalledOnce();
    expect(addMessages).toHaveBeenCalledOnce();
    expect(addMessages.mock.calls[0]?.[0]).toEqual([
      expect.objectContaining({ role: "system" }),
      expect.objectContaining({
        role: "assistant",
        content: expect.stringContaining("第一段回复。"),
      }),
    ]);
    expect(triggerCompression).toHaveBeenCalledWith(CHAT_ID);
  });
});
