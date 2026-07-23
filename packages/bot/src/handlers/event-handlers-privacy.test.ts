import type { Api } from "grammy";
import type { PollAnswer } from "grammy/types";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PendingActionRegistry, PendingPoll } from "../services/pending-actions.js";

const { continueChatMock } = vi.hoisted(() => ({ continueChatMock: vi.fn() }));

vi.mock("../services/continue-chat.js", () => ({
  continueChat: continueChatMock,
}));

import { createPollAnswerHandler } from "./event-handlers.js";

afterEach(() => {
  vi.clearAllMocks();
  vi.useRealTimers();
});

function poll(ownerUserId?: number): PendingPoll {
  return {
    type: "poll",
    pollId: "poll-1",
    chatId: -100,
    ownerUserId,
    messageId: 7,
    question: "Choose",
    options: ["A", "B"],
    answers: new Map(),
    createdAt: Date.now(),
  };
}

function answer(): PollAnswer {
  return {
    poll_id: "poll-1",
    user: { id: 99, is_bot: false, first_name: "Voter" },
    option_ids: [0],
    option_persistent_ids: [],
  };
}

describe("poll continuation privacy", () => {
  it("attributes a group poll continuation to the poll owner", async () => {
    vi.useFakeTimers();
    const pendingPoll = poll(42);
    const pendingActions = {
      getPoll: vi.fn().mockReturnValue(pendingPoll),
    } as unknown as PendingActionRegistry;
    const handler = createPollAnswerHandler({
      api: {} as Api,
      pendingActions,
      getContinueChatConfig: vi.fn().mockReturnValue({}),
      isPrivateChat: () => false,
    });

    await handler(answer());
    await vi.advanceTimersByTimeAsync(5_000);

    expect(continueChatMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.objectContaining({ chatId: -100, userId: 42 }),
    );
  });

  it("attributes a legacy ownerless group poll to the voter", async () => {
    vi.useFakeTimers();
    const pendingActions = {
      getPoll: vi.fn().mockReturnValue(poll()),
    } as unknown as PendingActionRegistry;
    const handler = createPollAnswerHandler({
      api: {} as Api,
      pendingActions,
      getContinueChatConfig: vi.fn().mockReturnValue({}),
      isPrivateChat: () => false,
    });

    await handler(answer());
    await vi.advanceTimersByTimeAsync(5_000);

    expect(continueChatMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.objectContaining({ chatId: -100, userId: 99 }),
    );
  });
});
