import { describe, expect, it, vi } from "vitest";
import type { QuoteService } from "../services/quote-service.js";
import { createQuoteCommands, parseQuoteArgs } from "./quote.js";

describe("quote command handlers", () => {
  it.each(["0", "11", "-11", "1 2", "r r", "#123", "unknown"])(
    "rejects invalid arguments %s",
    (raw) => expect(parseQuoteArgs(raw)).toBeUndefined(),
  );
  it("parses count, preview and inline color", () =>
    expect(parseQuoteArgs("-3 r purple")).toEqual({
      count: -3,
      includeReplyPreview: true,
      color: "purple",
    }));
  function setup() {
    const send = vi.fn(async () => ({ messageId: 99, receiptSaved: true }));
    const store = { getQuoteColor: vi.fn(), setQuoteColor: vi.fn() };
    const service = { send, deps: { store } } as unknown as QuoteService;
    const ctx = {
      match: "",
      chat: { id: 10, type: "private" },
      from: { id: 7, language_code: "en" },
      me: { id: 100 },
      message: {
        message_id: 2,
        reply_to_message: {
          message_id: 1,
          date: Math.floor(Date.now() / 1000),
          chat: { id: 10, type: "private" },
          from: { id: 7, first_name: "Alice", is_bot: false },
          text: "Hello 😀 world",
        },
      },
      reply: vi.fn(),
      api: { getChatMember: vi.fn(async () => ({ status: "member" })) },
    };
    const handlers = createQuoteCommands(service, { adminIds: [] });
    return { ctx, handlers, send, store };
  }
  it("single live reply and UTF16 selection work without an AI runtime", async () => {
    const f = setup();
    Object.assign(f.ctx.message, { quote: { text: "😀", position: 6 } });
    await f.handlers.q(f.ctx as unknown as Parameters<typeof f.handlers.q>[0], async () => {});
    expect(f.send).toHaveBeenCalledWith(
      expect.objectContaining({
        anchorId: 1,
        liveSources: [expect.objectContaining({ text: "😀" })],
      }),
    );
  });
  it("rejects cross-topic replies", async () => {
    const f = setup();
    Object.assign(f.ctx.message.reply_to_message, { is_topic_message: true, message_thread_id: 4 });
    await f.handlers.q(f.ctx as unknown as Parameters<typeof f.handlers.q>[0], async () => {});
    expect(f.send).not.toHaveBeenCalled();
    expect(f.ctx.reply).toHaveBeenCalledWith(expect.stringContaining("topic"));
  });
  it("allows private reset, but requires group admin to persist a default", async () => {
    const f = setup();
    f.ctx.match = "reset";
    await f.handlers.qcolor(
      f.ctx as unknown as Parameters<typeof f.handlers.qcolor>[0],
      async () => {},
    );
    expect(f.store.setQuoteColor).toHaveBeenCalledWith(10, undefined);
    f.store.setQuoteColor.mockClear();
    f.ctx.chat.type = "supergroup";
    f.ctx.match = "purple";
    await f.handlers.qcolor(
      f.ctx as unknown as Parameters<typeof f.handlers.qcolor>[0],
      async () => {},
    );
    expect(f.store.setQuoteColor).not.toHaveBeenCalled();
    f.ctx.api.getChatMember.mockResolvedValue({ status: "administrator" });
    await f.handlers.qcolor(
      f.ctx as unknown as Parameters<typeof f.handlers.qcolor>[0],
      async () => {},
    );
    expect(f.store.setQuoteColor).toHaveBeenCalledWith(10, "#251D3A");
  });
});
