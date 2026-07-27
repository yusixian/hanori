import type { Api } from "grammy";
import type { Message } from "grammy/types";
import { describe, expect, it, vi } from "vitest";
import { createBehaviorTools } from "./behavior.js";

function sentMessage(messageId: number, text: string): Message.TextMessage {
  return {
    message_id: messageId,
    date: 0,
    chat: { id: 42, type: "private" },
    text,
  } as Message.TextMessage;
}

describe("behavior tools", () => {
  it("stores mood state without copying tool arguments into generic logs", async () => {
    const onLog = vi.fn();
    const mood = "private mood";
    const reason = "private reason";
    const tools = createBehaviorTools({
      api: {} as Api,
      chatId: 42,
      recentBotMessageIds: [],
      moodState: new Map(),
      onLog,
    });
    const execute = tools.set_mood?.execute;
    if (!execute) throw new Error("Expected set_mood execute");

    await execute({ mood, reason }, { toolCallId: "mood", messages: [] });

    expect(JSON.stringify(onLog.mock.calls)).not.toContain(mood);
    expect(JSON.stringify(onLog.mock.calls)).not.toContain(reason);
    expect(onLog).toHaveBeenCalledWith({
      level: "debug",
      message: "Mood state updated",
      meta: { chatId: 42, moodLength: mood.length, reasonLength: reason.length },
    });
  });

  it("allows distinct multi_message batches while blocking duplicate content", async () => {
    let nextMessageId = 1;
    const sendMessage = vi
      .fn()
      .mockImplementation(async (_chatId: number, text: string) =>
        sentMessage(nextMessageId++, text),
      );
    const onMultiMessageSent = vi.fn();
    const tools = createBehaviorTools({
      api: {
        sendMessage,
        sendChatAction: vi.fn().mockResolvedValue(true),
      } as unknown as Api,
      chatId: 42,
      recentBotMessageIds: [],
      moodState: new Map(),
      richMessageEnabled: false,
      onMultiMessageSent,
    });
    const execute = tools.multi_message?.execute;
    if (!execute) throw new Error("Expected multi_message execute");
    const first = { messages: [{ text: "ack one" }, { text: "ack two" }] };
    const followUp = { messages: [{ text: "result one" }, { text: "result two" }] };

    await expect(execute(first, { toolCallId: "first", messages: [] })).resolves.toEqual({
      sent: 2,
    });
    await expect(execute(first, { toolCallId: "duplicate", messages: [] })).resolves.toEqual(
      expect.objectContaining({ blocked: true }),
    );
    await expect(execute(followUp, { toolCallId: "follow-up", messages: [] })).resolves.toEqual({
      sent: 2,
    });

    expect(sendMessage).toHaveBeenCalledTimes(4);
    expect(onMultiMessageSent.mock.calls.map(([text]) => text)).toEqual([
      "ack one",
      "ack two",
      "result one",
      "result two",
    ]);
  });
});
