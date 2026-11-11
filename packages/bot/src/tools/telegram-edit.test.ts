import type { ConversationCallbacks } from "@cos-tool-bot/shared";
import type { Api } from "grammy";
import { describe, expect, it, vi } from "vitest";
import { createTelegramTools } from "./telegram.js";

function setup({ own = true, visible = [12], rich = false } = {}) {
  const editMessageText = vi.fn().mockResolvedValue({ message_id: 12 });
  const rawEdit = vi.fn().mockResolvedValue({ message_id: 12 });
  const findOwnMessage = vi.fn().mockResolvedValue(own);
  const updateOwnMessage = vi.fn().mockResolvedValue(undefined);
  const tool = createTelegramTools({
    api: { editMessageText, raw: { editMessageText: rawEdit } } as unknown as Api,
    chatId: 42,
    recentBotMessageIds: [],
    getReplyableMessageIds: () => visible,
    richMessageEnabled: rich,
    conversation: { findOwnMessage, updateOwnMessage } as unknown as ConversationCallbacks,
  }).edit_own_message!;
  const edit = (text = "**bold** [link](https://example.com)\n\n```js\nlet a = 1;\n```") =>
    tool.execute!({ message_id: 12, text }, { toolCallId: "edit", messages: [] });
  return { edit, editMessageText, rawEdit, findOwnMessage, updateOwnMessage };
}

describe("edit_own_message", () => {
  it("edits a visible durable bot message after restart and synchronizes history", async () => {
    const s = setup();
    expect(await s.edit()).toEqual({ success: true, history_synced: true });
    expect(s.findOwnMessage).toHaveBeenCalledWith(42, 12);
    expect(s.editMessageText).toHaveBeenCalledWith(42, 12, expect.stringContaining("<b>bold</b>"), {
      parse_mode: "HTML",
    });
    expect(s.editMessageText.mock.calls[0]![2]).toContain('<a href="https://example.com">link</a>');
    expect(s.editMessageText.mock.calls[0]![2]).toContain("<pre>");
    expect(s.updateOwnMessage).toHaveBeenCalledWith(42, 12, expect.stringContaining("**bold**"));
  });
  it("updates a just-sent message in memory without creating durable history in privacy-off mode", async () => {
    const recentBotMessageIds: number[] = [];
    const onOwnMessageEdited = vi.fn();
    const api = {
      editMessageText: vi.fn().mockResolvedValue({ message_id: 12 }),
    } as unknown as Api;
    const tool = createTelegramTools({
      api,
      chatId: 42,
      recentBotMessageIds,
      onOwnMessageEdited,
    }).edit_own_message!;
    recentBotMessageIds.push(12);
    await tool.execute!(
      { message_id: 12, text: "corrected" },
      { toolCallId: "edit", messages: [] },
    );
    expect(onOwnMessageEdited).toHaveBeenCalledWith(12, "corrected");
    expect(api.editMessageText).toHaveBeenCalledTimes(1);
  });
  it("uses the native rich edit API for structured Markdown", async () => {
    const s = setup({ rich: true });
    await s.edit("$$x^2$$");
    expect(s.rawEdit).toHaveBeenCalledWith({
      chat_id: 42,
      message_id: 12,
      rich_message: { markdown: "$$x^2$$" },
    });
    expect(s.editMessageText).not.toHaveBeenCalled();
  });
  it("retries plain only after a definite entity parsing rejection", async () => {
    const s = setup();
    s.editMessageText.mockRejectedValueOnce({
      error_code: 400,
      description: "Bad Request: can't parse entities",
    });
    await s.edit("**bold**");
    expect(s.editMessageText).toHaveBeenNthCalledWith(2, 42, 12, "**bold**");
  });
  it.each([
    new Error("timeout"),
    { error_code: 429, description: "Too Many Requests" },
    { error_code: 400, description: "message can't be edited" },
  ])("does not retry unrelated failures", async (error) => {
    const s = setup();
    s.editMessageText.mockRejectedValue(error);
    expect(await s.edit()).toHaveProperty("error");
    expect(s.editMessageText).toHaveBeenCalledTimes(1);
    expect(s.updateOwnMessage).not.toHaveBeenCalled();
  });
  it.each([{ own: false }, { visible: [] }])(
    "rejects unowned or invisible messages",
    async (options) => {
      const s = setup(options);
      expect(await s.edit()).toHaveProperty("error");
      expect(s.editMessageText).not.toHaveBeenCalled();
      expect(s.updateOwnMessage).not.toHaveBeenCalled();
    },
  );
  it("reports partial success and repairs history on a same-content retry", async () => {
    const s = setup();
    s.updateOwnMessage.mockRejectedValueOnce(new Error("database unavailable"));
    expect(await s.edit()).toMatchObject({ success: true, history_synced: false });
    s.editMessageText.mockRejectedValueOnce({
      error_code: 400,
      description: "Bad Request: message is not modified",
    });
    expect(await s.edit()).toEqual({ success: true, history_synced: true });
    expect(s.updateOwnMessage).toHaveBeenCalledTimes(2);
  });
});
