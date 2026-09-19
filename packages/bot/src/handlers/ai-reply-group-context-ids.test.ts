import type { Tool } from "ai";
import type { Api } from "grammy";
import { describe, expect, it, vi } from "vitest";
import { createTelegramTools } from "../tools/telegram.js";
import { RingBuffer } from "../utils/ring-buffer.js";
import type { BufferedMessage } from "./ai-reply.js";
import { formatGroupContextMessages } from "./ai-reply.js";

function buffered(messageId: number, userName: string, text: string): BufferedMessage {
  return { messageId, userId: messageId, userName, text, timestamp: 0 };
}

describe("group ring buffer message ids", () => {
  it("attaches the Telegram message id to every rendered line", () => {
    const rendered = formatGroupContextMessages([
      buffered(4820, "Nahida", "这个 hydration 的文章讲了啥"),
      buffered(4821, "cos", "帮我写个频道摘要"),
    ]);

    expect(rendered).toBe(
      "[#4820 Nahida]: 这个 hydration 的文章讲了啥\n[#4821 cos]: 帮我写个频道摘要",
    );
  });

  it("keeps the forward attribution below the id line", () => {
    const rendered = formatGroupContextMessages([
      {
        ...buffered(4822, "cos", "转发的正文"),
        forwardOrigin: { type: "channel", name: "某频道" },
      },
    ]);

    expect(rendered.startsWith("[#4822 cos]: ")).toBe(true);
    expect(rendered).toContain("转发的正文");
  });
});

describe("a reply target that the sliding window dropped", () => {
  it("disappears from the prompt and the tool refuses it", async () => {
    const buffer = new RingBuffer<BufferedMessage>(3);
    buffer.push(buffered(4820, "Nahida", "这个 hydration 的文章讲了啥"));
    for (const id of [4831, 4832, 4833]) {
      buffer.push(buffered(id, "cos", `后来的第 ${id} 条`));
    }

    const visible = buffer.getAll();
    const rendered = formatGroupContextMessages(visible);
    expect(rendered).not.toContain("#4820");

    const api = { sendMessage: vi.fn() } as unknown as Api;
    const tools = createTelegramTools({
      api,
      chatId: -1001,
      recentBotMessageIds: [],
      getReplyableMessageIds: () => visible.map((message) => message.messageId),
    });

    const result = await (
      tools.reply_to_specific as Tool as unknown as {
        execute: (input: unknown, options: { abortSignal: AbortSignal }) => Promise<unknown>;
      }
    ).execute(
      { reply_to_message_id: 4820, text: "《Different hydration and rendering strategies》摘要……" },
      { abortSignal: new AbortController().signal },
    );

    expect(api.sendMessage).not.toHaveBeenCalled();
    expect(result).toMatchObject({ available_message_ids: [4831, 4832, 4833] });
  });
});
