import { describe, expect, it, vi } from "vitest";
import type { Api } from "grammy";
import { showRichThinkingDraft, streamToChat } from "./stream-reply.js";

describe("Rich Message streaming", () => {
  it("uses tg-thinking only for the temporary draft", async () => {
    const sendRichMessageDraft = vi.fn().mockResolvedValue(true);
    const api = { sendRichMessageDraft } as unknown as Api;

    await expect(showRichThinkingDraft(api, 123, 7)).resolves.toBe(true);
    expect(sendRichMessageDraft).toHaveBeenCalledWith(123, 7, {
      html: "<tg-thinking>Thinking...</tg-thinking>",
    });
  });

  it("streams accumulated Markdown and persists a clean final Rich Message", async () => {
    const rawSendRichMessageDraft = vi.fn().mockResolvedValue(true);
    const rawSendRichMessage = vi.fn().mockResolvedValue({
      message_id: 42,
      date: 0,
      chat: { id: 123, type: "private" },
      rich_message: { blocks: [] },
    });
    const api = {
      sendRichMessageDraft: vi.fn().mockResolvedValue(true),
      raw: {
        sendRichMessageDraft: rawSendRichMessageDraft,
        sendRichMessage: rawSendRichMessage,
      },
    } as unknown as Api;
    const stream = (async function* () {
      yield "# Hello";
      yield "\n\n- one";
    })();

    const result = await streamToChat(api, 123, stream);

    expect(result.text).toBe("# Hello\n\n- one");
    expect(result.sentMessages[0]?.message_id).toBe(42);
    expect(rawSendRichMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        chat_id: 123,
        rich_message: { markdown: "# Hello\n\n- one" },
      }),
      undefined,
    );
    expect(JSON.stringify(rawSendRichMessage.mock.calls)).not.toContain("tg-thinking");
  });

  it("uses the legacy draft and HTML formatting path when Rich Messages are disabled", async () => {
    const rawSendMessageDraft = vi.fn().mockResolvedValue(true);
    const rawSendMessage = vi.fn().mockImplementation(({ text }) =>
      Promise.resolve({
        message_id: 43,
        date: 0,
        chat: { id: 123, type: "private" },
        text,
      }),
    );
    const editMessageText = vi.fn().mockResolvedValue(true);
    const api = {
      editMessageText,
      sendRichMessageDraft: vi.fn(),
      raw: {
        sendMessageDraft: rawSendMessageDraft,
        sendMessage: rawSendMessage,
        sendRichMessageDraft: vi.fn(),
        sendRichMessage: vi.fn(),
      },
    } as unknown as Api;
    const stream = (async function* () {
      yield "**Hello**";
    })();

    const result = await streamToChat(api, 123, stream, false);

    expect(result.sentMessages[0]?.message_id).toBe(43);
    expect(api.sendRichMessageDraft).not.toHaveBeenCalled();
    expect(api.raw.sendRichMessage).not.toHaveBeenCalled();
    expect(editMessageText).toHaveBeenCalledWith(123, 43, "<b>Hello</b>", {
      parse_mode: "HTML",
    });
  });
});
