import { describe, expect, it, vi } from "vitest";
import type { Api } from "grammy";
import { sendMarkdownWithFallback, sendRichMessageStrict } from "./rich-message.js";

function message(messageId: number) {
  return { message_id: messageId, date: 0, chat: { id: 1, type: "private" } };
}

describe("rich message delivery", () => {
  it("sends strict Markdown and HTML without hiding Telegram errors", async () => {
    const sendRichMessage = vi.fn().mockResolvedValue(message(1));
    const api = { sendRichMessage } as unknown as Api;

    await sendRichMessageStrict(api, 123, "markdown", "# Hello");
    await sendRichMessageStrict(api, -100, "html", "<h1>Hello</h1>");

    expect(sendRichMessage).toHaveBeenNthCalledWith(1, 123, { markdown: "# Hello" }, undefined);
    expect(sendRichMessage).toHaveBeenNthCalledWith(2, -100, { html: "<h1>Hello</h1>" }, undefined);
  });

  it("prefers a native Rich Message", async () => {
    const sendRichMessage = vi.fn().mockResolvedValue(message(10));
    const sendMessage = vi.fn();
    const api = { sendRichMessage, sendMessage } as unknown as Api;

    const result = await sendMarkdownWithFallback(api, 123, "# Hello", true);

    expect(result).toMatchObject({ mode: "rich", message: { message_id: 10 } });
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it("falls back to basic HTML and then plain text", async () => {
    const sendRichMessage = vi.fn().mockRejectedValue(new Error("method unavailable"));
    const sendMessage = vi
      .fn()
      .mockRejectedValueOnce(new Error("invalid HTML"))
      .mockResolvedValueOnce(message(12));
    const onFallback = vi.fn();
    const api = { sendRichMessage, sendMessage } as unknown as Api;

    const result = await sendMarkdownWithFallback(
      api,
      -100,
      "**Hello**",
      true,
      { reply_parameters: { message_id: 7 } },
      onFallback,
    );

    expect(result).toMatchObject({ mode: "plain", message: { message_id: 12 } });
    expect(sendMessage).toHaveBeenNthCalledWith(
      1,
      -100,
      "<b>Hello</b>",
      expect.objectContaining({ parse_mode: "HTML" }),
    );
    expect(sendMessage).toHaveBeenNthCalledWith(
      2,
      -100,
      "**Hello**",
      expect.objectContaining({ reply_parameters: { message_id: 7 } }),
    );
    expect(onFallback.mock.calls.map(([mode]) => mode)).toEqual(["rich", "html"]);
  });

  it("skips the Rich Message API when the global setting is disabled", async () => {
    const sendRichMessage = vi.fn();
    const sendMessage = vi.fn().mockResolvedValue(message(13));
    const api = { sendRichMessage, sendMessage } as unknown as Api;

    const result = await sendMarkdownWithFallback(api, 123, "**Hello**", false);

    expect(result).toMatchObject({ mode: "html", message: { message_id: 13 } });
    expect(sendRichMessage).not.toHaveBeenCalled();
    expect(sendMessage).toHaveBeenCalledWith(123, "<b>Hello</b>", {
      parse_mode: "HTML",
    });
  });
});
