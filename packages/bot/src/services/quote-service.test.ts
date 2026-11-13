import { describe, expect, it, vi } from "vitest";
import sharp from "sharp";
import type { Api } from "grammy";
import type { QuoteRenderInput, QuoteSource, UserPrivacyCallbacks } from "@cos-tool-bot/shared";
import { QuoteService } from "./quote-service.js";
import { createQuoteTools } from "../tools/quote.js";
import { createOnceGuard } from "../tools/utils.js";

const source = (id = 1, text = "Hello"): QuoteSource => ({
  version: 1,
  messageId: id,
  threadId: null,
  capturedAt: Date.now(),
  text,
  entities: [],
  author: { key: "hidden", name: "Alice" },
  privacyUserIds: [],
});
function setup() {
  const store = {
    getQuoteSources: vi.fn(async () => [] as QuoteSource[]),
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
      height: 512,
    })),
  };
  const api = {
    getChat: vi.fn(async () => ({})),
    sendChatAction: vi.fn(async () => true),
    sendSticker: vi.fn(async () => ({ message_id: 99 })),
    sendDocument: vi.fn(async () => ({ message_id: 99 })),
  };
  const buffer = vi.fn(async () => [] as QuoteSource[]);
  const service = new QuoteService(
    { store, renderer },
    { api: api as unknown as Api, deliveryApi: api as unknown as Api, getBufferedSources: buffer },
  );
  const request = { chatId: 10, threadId: null, userId: 7, anchorId: 1, liveSources: [source()] };
  return { store, renderer, api, buffer, service, request };
}
describe("quote delivery", () => {
  it("keeps long same-author bodies separate and bounds emoji parent previews by UTF16", async () => {
    const f = setup();
    const first = {
      ...source(1, "甲".repeat(4096)),
      replyToMessageId: 3,
      author: { key: "hidden", name: "长".repeat(200) },
    };
    await f.service.send({
      ...f.request,
      messageIds: [1, 2],
      snapshotOnly: true,
      includeReplyPreview: true,
      liveSources: [first, source(2, "乙".repeat(4096)), source(3, "😀".repeat(180))],
    });
    const input = f.renderer.render.mock.calls[0]![0];
    expect(input.messages).toHaveLength(2);
    expect(input.messages[0]!.author.name).toHaveLength(200);
    expect(input.messages[0]!.text).toHaveLength(4096);
    expect(input.messages[0]!.reply!.text.length).toBeLessThanOrEqual(180);
    expect(input.messages[0]!.reply!.text.endsWith("…")).toBe(true);
  });

  it("retains recently used avatars when its bounded LRU cache fills", async () => {
    const f = setup();
    const bytes = await sharp({ create: { width: 2, height: 2, channels: 3, background: "red" } })
      .png()
      .toBuffer();
    const getUserProfilePhotos = vi.fn(async (_id: number) => ({
      photos: [[{ file_id: "avatar" }]],
    }));
    const service = new QuoteService(f.service.deps, {
      api: {
        ...f.api,
        getUserProfilePhotos,
        getFile: vi.fn(async () => ({ file_path: "photos/avatar", file_size: bytes.length })),
      } as unknown as Api,
      deliveryApi: f.api as unknown as Api,
      fetchImpl: vi.fn(async () => new Response(bytes)) as unknown as typeof fetch,
    });
    const send = (id: number) =>
      service.send({
        ...f.request,
        liveSources: [{ ...source(), author: { key: `user:${id}`, name: "Test", userId: id } }],
      });
    for (let id = 1; id <= 64; id++) await send(id);
    await send(1);
    await send(65);
    await send(1);
    expect(getUserProfilePhotos.mock.calls.filter(([id]) => id === 1)).toHaveLength(1);
    await send(2);
    expect(getUserProfilePhotos.mock.calls.filter(([id]) => id === 2)).toHaveLength(2);
  });

  it("preserves multiple static image blocks without discarding same-author media", async () => {
    const f = setup();
    const bytes = await sharp({ create: { width: 2, height: 2, channels: 3, background: "red" } })
      .png()
      .toBuffer();
    const getFile = vi.fn(async () => ({ file_path: "photos/test.png", file_size: bytes.length }));
    const fetchImpl = vi.fn(async () => new Response(bytes));
    const service = new QuoteService(f.service.deps, {
      api: { ...f.api, getFile } as unknown as Api,
      deliveryApi: f.api as unknown as Api,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    await service.send({
      ...f.request,
      messageIds: [1, 2],
      liveSources: [1, 2].map((id) => ({
        ...source(id),
        media: { kind: "sticker" as const, fileId: `file${id}`, width: 2, height: 2 },
      })),
    });
    const input = f.renderer.render.mock.calls[0]![0];
    expect(input.messages).toHaveLength(2);
    expect(input.messages.every((message) => message.media?.mimeType === "image/png")).toBe(true);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });
  it("rejects oversized assets before downloading or rendering", async () => {
    const f = setup();
    const fetchImpl = vi.fn();
    const service = new QuoteService(f.service.deps, {
      api: {
        ...f.api,
        getFile: vi.fn(async () => ({ file_path: "photos/a", file_size: 9 * 1024 * 1024 })),
      } as unknown as Api,
      deliveryApi: f.api as unknown as Api,
      fetchImpl,
    });
    await expect(
      service.send({
        ...f.request,
        liveSources: [
          { ...source(), media: { kind: "photo", fileId: "large", width: 100, height: 100 } },
        ],
      }),
    ).rejects.toThrow("文件过大");
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(f.renderer.render).not.toHaveBeenCalled();
  });

  it("quotes a live reply without history and records exactly one delivery", async () => {
    const f = setup();
    expect(await f.service.send(f.request)).toMatchObject({ messageId: 99, receiptSaved: true });
    expect(f.store.getQuoteSources).not.toHaveBeenCalled();
    expect(f.api.sendSticker).toHaveBeenCalledTimes(1);
    expect(f.store.markQuoteOutput).toHaveBeenCalledWith(10, 99);
  });
  it("reports short local windows and preserves ascending backwards order", async () => {
    const f = setup();
    f.store.getQuoteSources.mockResolvedValue([source(1), source(2, "Second")]);
    const result = await f.service.send({ ...f.request, anchorId: 2, count: -3, liveSources: [] });
    expect(result.count).toBe(2);
    expect(result.notice).toContain("2/3");
    expect(f.renderer.render.mock.calls[0]![0]).toMatchObject({
      messages: [{ text: "Hello" }, { text: "Second" }],
    });
  });
  it("rejects a generated quote receipt", async () => {
    const f = setup();
    f.store.isQuoteOutput.mockResolvedValue(true);
    await expect(f.service.send(f.request)).rejects.toThrow("已经是生成");
    expect(f.api.sendSticker).not.toHaveBeenCalled();
  });
  it("retains delivery success when receipt persistence fails", async () => {
    const f = setup();
    f.store.markQuoteOutput.mockRejectedValue(new Error("db unavailable"));
    expect(await f.service.send(f.request)).toMatchObject({ messageId: 99, receiptSaved: false });
    expect(f.api.sendSticker).toHaveBeenCalledTimes(1);
  });
  it("never retries an uncertain Telegram send", async () => {
    const f = setup();
    f.api.sendSticker.mockRejectedValue(new Error("connection lost"));
    await expect(f.service.send(f.request)).rejects.toThrow("connection lost");
    expect(f.api.sendSticker).toHaveBeenCalledTimes(1);
    expect(f.store.markQuoteOutput).not.toHaveBeenCalled();
  });
  it("cancellation after rendering prevents sending", async () => {
    const f = setup();
    const abort = new AbortController();
    f.renderer.render.mockImplementation(async () => {
      abort.abort();
      return { data: new Uint8Array(), format: "webp", width: 1, height: 1 };
    });
    await expect(f.service.send({ ...f.request, signal: abort.signal })).rejects.toThrow();
    expect(f.api.sendSticker).not.toHaveBeenCalled();
  });
  it("snapshot mode neither reloads edited sources nor fetches invisible parents", async () => {
    const f = setup();
    f.buffer.mockResolvedValue([source(1, "Changed")]);
    f.store.getQuoteSources.mockResolvedValue([source(2, "Invisible parent")]);
    const result = await f.service.send({
      ...f.request,
      snapshotOnly: true,
      messageIds: [1],
      liveSources: [{ ...source(), replyToMessageId: 2 }],
      includeReplyPreview: true,
    });
    expect(f.buffer).not.toHaveBeenCalled();
    expect(f.store.getQuoteSources).not.toHaveBeenCalled();
    expect(result.notice).toContain("父消息");
    expect(f.renderer.render.mock.calls[0]![0]).toMatchObject({ messages: [{ text: "Hello" }] });
  });
  it("rejects missing snapshot sources even if available in storage", async () => {
    const f = setup();
    f.store.getQuoteSources.mockResolvedValue([source(2)]);
    await expect(
      f.service.send({ ...f.request, snapshotOnly: true, messageIds: [2] }),
    ).rejects.toThrow("真实语录来源");
    expect(f.store.getQuoteSources).not.toHaveBeenCalled();
  });
  it("rejects invented excerpts and protected chats before delivery", async () => {
    const f = setup();
    await expect(f.service.send({ ...f.request, quoteText: "Invented" })).rejects.toThrow("原文");
    f.api.getChat.mockResolvedValue({ has_protected_content: true });
    await expect(f.service.send(f.request)).rejects.toThrow("受保护");
    expect(f.api.sendSticker).not.toHaveBeenCalled();
  });
  it("rejects an opted-out requester even when sources allow quoting", async () => {
    const f = setup();
    const privacy = { getMode: vi.fn(async () => "off") } as unknown as UserPrivacyCallbacks;
    const service = new QuoteService(f.service.deps, {
      api: f.api as unknown as Api,
      deliveryApi: f.api as unknown as Api,
      privacy,
    });
    await expect(service.send(f.request)).rejects.toThrow("off");
    expect(f.renderer.render).not.toHaveBeenCalled();
  });
});
describe("quote AI tool", () => {
  it("rejects forged IDs and consumes its once guard", async () => {
    const f = setup();
    const tool = createQuoteTools(f.service, {
      chatId: 10,
      userId: 7,
      visibleIds: () => [1],
      sources: [source()],
      onceGuard: createOnceGuard(),
    }).create_quote_sticker;
    const execute = tool.execute!;
    expect(await execute({ message_ids: [2] }, { toolCallId: "a", messages: [] })).toHaveProperty(
      "error",
    );
    await execute({ message_ids: [1] }, { toolCallId: "b", messages: [] });
    expect(f.api.sendSticker).not.toHaveBeenCalled();
  });
  it("accepts build-stage finalized sources, clones before awaiting, and sends once", async () => {
    const f = setup();
    const sources: QuoteSource[] = [];
    const tool = createQuoteTools(f.service, {
      chatId: 10,
      userId: 7,
      visibleIds: () => [1],
      sources,
      onceGuard: createOnceGuard(),
    }).create_quote_sticker;
    sources.push(source());
    const first = tool.execute!({ message_ids: [1] }, { toolCallId: "a", messages: [] });
    sources[0]!.text = "Changed after execution";
    await tool.execute!({ message_ids: [1] }, { toolCallId: "b", messages: [] });
    await first;
    expect(f.api.sendSticker).toHaveBeenCalledTimes(1);
    expect(f.renderer.render.mock.calls[0]![0]).toMatchObject({ messages: [{ text: "Hello" }] });
    expect(f.buffer).not.toHaveBeenCalled();
  });
});
