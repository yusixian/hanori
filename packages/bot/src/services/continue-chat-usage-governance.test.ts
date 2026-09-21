import type { Api } from "grammy";
import type { Message } from "grammy/types";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { continueChat, type ContinueChatConfig } from "./continue-chat.js";

const { streamTextMock } = vi.hoisted(() => ({ streamTextMock: vi.fn() }));

vi.mock("ai", async (importOriginal) => ({
  ...(await importOriginal<typeof import("ai")>()),
  streamText: streamTextMock,
}));

const BOT_ID = "00000000-0000-4000-8000-000000000017";
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

describe("continueChat usage governance", () => {
  it("charges a system continuation only to Bot/chat AI scopes and settles after delivery", async () => {
    streamTextMock.mockImplementationOnce(() => streamResult("定时提醒已完成。"));
    const usageGovernance = {
      reserve: vi.fn().mockResolvedValue({
        allowed: true,
        reservationId: "reservation-1",
        reservedUnits: 1,
        expiresAt: new Date("2026-09-01T00:00:00.000Z"),
      }),
      settle: vi.fn().mockResolvedValue("settled"),
      refund: vi.fn().mockResolvedValue("refunded"),
    };
    const api = {
      sendChatAction: vi.fn().mockResolvedValue(true),
      sendMessage: vi.fn(
        async (_chatId: number, text: string) =>
          ({
            message_id: 201,
            date: 0,
            chat: { id: CHAT_ID, type: "supergroup", title: "Test group" },
            text,
          }) as Message.TextMessage,
      ),
    } as unknown as Api;
    const config = {
      botId: BOT_ID,
      systemPrompt: "system",
      resolveSelection: () => ({ model: {} as never, modelId: "model-a", providerId: "p" }),
      messageConfig: { replyMode: "single", richMessageEnabled: false },
      recentBotMessageIds: new Map<number, number[]>(),
      pendingActions: {},
      moodState: new Map(),
      usageGovernance,
    } as unknown as ContinueChatConfig;

    await expect(
      continueChat(api, config, {
        chatId: CHAT_ID,
        userId: 42,
        eventDescription: "timer fired",
      }),
    ).resolves.toBe(true);

    expect(usageGovernance.reserve).toHaveBeenCalledWith({
      botId: BOT_ID,
      resource: "ai_reply",
      chatKind: "group",
      chatId: CHAT_ID,
      userId: undefined,
    });
    expect(usageGovernance.settle).toHaveBeenCalledWith({
      reservationId: "reservation-1",
      botId: BOT_ID,
      resource: "ai_reply",
    });
    expect(usageGovernance.refund).not.toHaveBeenCalled();
  });

  it("fails closed before model execution when a continuation exceeds its parent ceiling", async () => {
    const usageGovernance = {
      reserve: vi.fn().mockResolvedValue({
        allowed: false,
        reason: "hour",
        scope: "chat",
        subjectKey: String(CHAT_ID),
        limit: 120,
        used: 120,
      }),
      settle: vi.fn(),
      refund: vi.fn(),
    };
    const config = {
      botId: BOT_ID,
      resolveSelection: () => ({ model: {} as never, modelId: "model-a" }),
      usageGovernance,
    } as unknown as ContinueChatConfig;

    await expect(
      continueChat({} as Api, config, {
        chatId: CHAT_ID,
        eventDescription: "scheduled summary",
        requireDelivery: true,
      }),
    ).rejects.toThrow("usage limit reached");

    expect(streamTextMock).not.toHaveBeenCalled();
    expect(usageGovernance.settle).not.toHaveBeenCalled();
    expect(usageGovernance.refund).not.toHaveBeenCalled();
  });
});
