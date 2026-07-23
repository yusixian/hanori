import type { Tool } from "ai";
import type { Api } from "grammy";
import { describe, expect, it, vi } from "vitest";
import type { PendingActionRegistry } from "../services/pending-actions.js";
import { createTelegramTools } from "./telegram.js";

type ExecutableTool = {
  execute: (input: unknown, options: { abortSignal: AbortSignal }) => Promise<unknown>;
};

describe("telegram poll ownership", () => {
  it("records the requesting user as the owner of a tracked poll", async () => {
    const api = {
      sendPoll: vi.fn().mockResolvedValue({
        message_id: 7,
        poll: { id: "poll-1" },
      }),
    } as unknown as Api;
    const pendingActions = {
      registerPoll: vi.fn(),
    } as unknown as PendingActionRegistry;
    const tools = createTelegramTools({
      api,
      chatId: -100,
      userId: 42,
      recentBotMessageIds: [],
      pendingActions,
    });

    await (tools.send_poll as Tool as unknown as ExecutableTool).execute(
      {
        question: "Choose",
        poll_options: ["A", "B"],
        is_anonymous: false,
      },
      { abortSignal: new AbortController().signal },
    );

    expect(pendingActions.registerPoll).toHaveBeenCalledWith(
      "poll-1",
      -100,
      7,
      "Choose",
      ["A", "B"],
      42,
    );
  });
});
