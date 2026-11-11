import { describe, expect, it } from "vitest";
import { Api } from "grammy";
import { createBehaviorTools } from "../tools/behavior.js";
import { createTelegramTools } from "../tools/telegram.js";
import { bindTaskDestinationTopic } from "./scheduled-task-executor.js";

describe("task tool delivery topic", () => {
  it("routes real Telegram photo and multi-message tool sends to the approved topic", async () => {
    const api = new Api("123:test");
    const calls: Array<{ method: string; payload: unknown }> = [];
    api.config.use(async (_previous, method, payload) => {
      calls.push({ method, payload });
      return {
        ok: true,
        result: {
          message_id: calls.length,
          chat: { id: -2, type: "supergroup" },
          date: 0,
          text: "sent",
        },
      } as never;
    });
    bindTaskDestinationTopic(api, { chatId: -2, threadId: 7 });
    const telegram = createTelegramTools({ api, chatId: -2, recentBotMessageIds: [] });
    await telegram.send_photo!.execute!(
      { photo: "https://example.com/photo.jpg" },
      { toolCallId: "photo", messages: [] },
    );
    const behavior = createBehaviorTools({
      api,
      chatId: -2,
      recentBotMessageIds: [],
      moodState: new Map(),
    });
    await behavior.multi_message!.execute!(
      { messages: [{ text: "```js\nconst value = 1;\n```" }, { text: "Second" }] },
      { toolCallId: "multi", messages: [] },
    );
    expect(calls).toHaveLength(3);
    expect(calls.map((call) => call.method)).toEqual([
      "sendPhoto",
      "sendRichMessage",
      "sendMessage",
    ]);
    for (const call of calls)
      expect(call.payload).toMatchObject({ chat_id: -2, message_thread_id: 7 });
  });
});
