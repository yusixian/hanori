import type { QuoteRenderInput, QuoteSource } from "@cos-tool-bot/shared";
import { Bot, type Api } from "grammy";
import type { Chat, Message, User } from "grammy/types";
import { describe, expect, it, vi } from "vitest";
import { WrapperContext } from "../context.js";
import { QuoteService } from "../services/quote-service.js";
import { createQuoteCommands } from "./quote.js";
import { ActiveCommandRegistry } from "./registry.js";

function setup(isBot: boolean) {
  const bot = new Bot("100:fictional-test-token", { ContextConstructor: WrapperContext });
  bot.botInfo = {
    id: 100,
    is_bot: true,
    first_name: "Quote Bot",
    username: "quote_test_bot",
    can_join_groups: true,
    can_read_all_group_messages: true,
    supports_inline_queries: false,
    can_connect_to_business: false,
    has_main_web_app: false,
    has_topics_enabled: false,
    allows_users_to_create_topics: false,
    can_manage_bots: false,
    supports_join_request_queries: false,
  };
  bot.api.config.use(async () => {
    throw new Error("Unexpected Telegram request from command routing test");
  });
  const parent: QuoteSource = {
    version: 1,
    messageId: 10,
    threadId: null,
    capturedAt: Date.now(),
    text: "Fictional local parent",
    entities: [],
    author: { key: "user:8", name: "Parent author" },
    privacyUserIds: [8],
  };
  const store = {
    getQuoteSources: vi.fn(async () => [parent]),
    getQuoteReplyTargets: vi.fn(async () => ({ 20: 10 })),
    getQuoteColor: vi.fn(async () => undefined),
    setQuoteColor: vi.fn(),
    isQuoteOutput: vi.fn(async () => false),
    markQuoteOutput: vi.fn(async () => {}),
  };
  const renderer = {
    available: vi.fn(async () => true),
    render: vi.fn(async (_input: QuoteRenderInput) => ({
      data: new Uint8Array([1]),
      format: "webp" as const,
      width: 512,
      height: 256,
    })),
  };
  const api = {
    getChat: vi.fn(async () => ({ id: -100, type: "supergroup" })),
    getUserProfilePhotos: vi.fn(async () => ({ photos: [] })),
    sendChatAction: vi.fn(async () => true),
    sendSticker: vi.fn(async () => ({ message_id: 99 })),
  };
  const service = new QuoteService(
    { store, renderer },
    { api: api as unknown as Api, deliveryApi: api as unknown as Api },
  );
  const send = vi.spyOn(service, "send");
  new ActiveCommandRegistry(bot).register("q", createQuoteCommands(service, { adminIds: [] }).q);
  const unmatched = vi.fn();
  bot.use(unmatched);
  const message = (
    text: string,
  ): Message.TextMessage & { chat: Chat.SupergroupChat; from: User } => ({
    message_id: 30,
    date: Math.floor(Date.now() / 1000),
    chat: { id: -100, type: "supergroup", title: "Fictional group" },
    from: { id: 7, is_bot: false, first_name: "Requester", language_code: "en" },
    text,
    entities: [{ type: "bot_command", offset: 0, length: 2 }],
    reply_to_message: {
      message_id: 20,
      date: Math.floor(Date.now() / 1000),
      chat: { id: -100, type: "supergroup", title: "Fictional group" },
      from: { id: isBot ? 100 : 9, is_bot: isBot, first_name: "Source author" },
      text: "Fictional quoted body",
      reply_to_message: undefined,
    },
  });
  return { bot, service, send, store, renderer, api, unmatched, message };
}

describe("registered quote command routing", () => {
  it.each([false, true])(
    "routes an initial /q r through QuoteService and restores a local parent (source is_bot=%s)",
    async (isBot) => {
      const f = setup(isBot);
      const message = f.message("/q r");
      expect(message.reply_to_message?.reply_to_message).toBeUndefined();

      await f.bot.handleUpdate({ update_id: 1, message });

      expect(f.send).toHaveBeenCalledTimes(1);
      expect(f.send).toHaveBeenCalledWith(expect.objectContaining({ includeReplyPreview: true }));
      expect(f.store.getQuoteReplyTargets).toHaveBeenCalledWith(-100, null, [20]);
      expect(f.store.getQuoteSources).toHaveBeenCalledWith(-100, null, { ids: [10] });
      expect(f.renderer.render.mock.calls[0]![0].messages).toEqual([
        expect.objectContaining({
          text: "Fictional quoted body",
          reply: { author: "Parent author", text: "Fictional local parent" },
        }),
      ]);
      expect(f.api.sendSticker).toHaveBeenCalledTimes(1);
      expect(f.store.markQuoteOutput).toHaveBeenCalledWith(-100, 99);
      expect(f.unmatched).not.toHaveBeenCalled();
      f.service.close();
    },
  );

  it.each([false, true])(
    "does not resend when /q is edited to /q r (source is_bot=%s)",
    async (isBot) => {
      const f = setup(isBot);
      const message = f.message("/q");
      await f.bot.handleUpdate({ update_id: 1, message });
      expect(f.send).toHaveBeenCalledTimes(1);
      expect(f.send).toHaveBeenCalledWith(expect.objectContaining({ includeReplyPreview: false }));
      expect(f.api.sendSticker).toHaveBeenCalledTimes(1);
      expect(f.renderer.render.mock.calls[0]![0].messages[0]!.reply).toBeUndefined();
      expect(f.unmatched).not.toHaveBeenCalled();

      await f.bot.handleUpdate({
        update_id: 2,
        edited_message: { ...message, text: "/q r", edit_date: message.date + 1 },
      });

      expect(f.unmatched).toHaveBeenCalledTimes(1);
      expect(f.send).toHaveBeenCalledTimes(1);
      expect(f.renderer.render).toHaveBeenCalledTimes(1);
      expect(f.api.sendSticker).toHaveBeenCalledTimes(1);
      expect(f.store.markQuoteOutput).toHaveBeenCalledTimes(1);
      expect(f.store.getQuoteReplyTargets).not.toHaveBeenCalled();
      expect(f.store.getQuoteSources).not.toHaveBeenCalled();
      f.service.close();
    },
  );
});
