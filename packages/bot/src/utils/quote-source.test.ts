import { describe, expect, it, vi } from "vitest";
import type { Message } from "grammy/types";
import type { UserPrivacyCallbacks } from "@cos-tool-bot/shared";
import {
  captureQuoteSource,
  normalizeQuoteText,
  quoteSourceExcerpt,
  isQuoteSourceAllowed,
} from "./quote-source.js";
const message = (extra: Record<string, unknown> = {}) =>
  ({
    message_id: 10,
    date: 100,
    chat: { id: -100, type: "supergroup" },
    from: { id: 5, is_bot: false, first_name: "测试" },
    text: "你好😀世界",
    ...extra,
  }) as Message;
const options = { chatId: -100, threadId: null };
const privacy = (extra: object = {}) =>
  ({ getMode: vi.fn().mockResolvedValue("normal"), ...extra }) as unknown as UserPrivacyCallbacks;
describe("quote source normalization", () => {
  it("uses UTF16 offsets and redacts selected spoiler before rendering", () => {
    expect(
      normalizeQuoteText(
        "甲😀秘密乙",
        [
          { type: "bold", offset: 0, length: 6 },
          { type: "spoiler", offset: 3, length: 2 },
        ],
        { text: "😀秘密", position: 1 },
      ),
    ).toEqual({ text: "😀[剧透已隐藏]", entities: [{ type: "bold", offset: 0, length: 2 }] });
  });
  it("rejects split graphemes and malformed spoiler offsets", () => {
    expect(() => normalizeQuoteText("a👩‍💻b", [], { text: "👩" })).toThrow("invalid_excerpt");
    expect(() => normalizeQuoteText("😀秘密", [{ type: "spoiler", offset: 1, length: 2 }])).toThrow(
      "invalid_spoiler",
    );
  });
  it("removes link targets and clips styles for exact excerpts", async () => {
    const result = await captureQuoteSource(
      message({
        entities: [{ type: "text_link", offset: 0, length: 2, url: "https://secret.invalid" }],
      }),
      options,
    );
    expect("source" in result).toBe(true);
    if (!("source" in result)) return;
    expect(result.source.entities).toEqual([{ type: "text_link", offset: 0, length: 2 }]);
    expect(quoteSourceExcerpt(result.source, "你好").text).toBe("你好");
    expect(() => quoteSourceExcerpt(result.source, "伪造")).toThrow("invalid_excerpt");
  });
  it.each([
    { chatId: -200, threadId: null },
    { chatId: -100, threadId: 3 },
  ])("rejects live replies outside scope %j", async (scope) => {
    expect(await captureQuoteSource(message(), scope)).toEqual({ reason: "scope" });
  });
  it("keeps topic provenance instead of relabeling a reply", async () => {
    expect(
      await captureQuoteSource(message({ is_topic_message: true, message_thread_id: 3 }), options),
    ).toEqual({ reason: "scope" });
  });
  it("rejects protected messages and quote commands", async () => {
    expect(await captureQuoteSource(message({ has_protected_content: true }), options)).toEqual({
      reason: "protected",
    });
    expect(await captureQuoteSource(message({ text: "/q -3" }), options)).toEqual({
      reason: "command",
    });
  });
  it("does not transport spoiler media file IDs", async () => {
    const result = await captureQuoteSource(
      message({
        text: undefined,
        has_media_spoiler: true,
        photo: [{ file_id: "secret", width: 10, height: 10 }],
      }),
      options,
    );
    expect(result).toMatchObject({ source: { text: "[剧透已隐藏]" } });
    expect("source" in result && result.source.media).toBeUndefined();
  });
  it("allows ordinary Bot static stickers; output receipts are checked by the service", async () => {
    expect(
      await captureQuoteSource(
        message({
          text: undefined,
          from: { id: 9, is_bot: true, first_name: "Bot" },
          sticker: {
            file_id: "normal",
            is_animated: false,
            is_video: false,
            width: 128,
            height: 128,
          },
        }),
        options,
      ),
    ).toMatchObject({ source: { media: { kind: "sticker", fileId: "normal" } } });
  });
  it("never resolves hidden forward identity and checks known forward author privacy", async () => {
    const p = privacy();
    const result = await captureQuoteSource(
      message({ forward_origin: { type: "hidden_user", sender_user_name: "匿名", date: 90 } }),
      options,
      p,
    );
    expect(result).toMatchObject({
      source: {
        author: { key: "hidden:10", name: "匿名" },
        privacyUserIds: [5],
        capturedAt: 90000,
      },
    });
    expect(p.getMode).toHaveBeenCalledWith(5);
    const hidden = privacy({ getMode: vi.fn(async (id) => (id === 7 ? "off" : "normal")) });
    expect(
      await captureQuoteSource(
        message({
          forward_origin: {
            type: "user",
            date: 90,
            sender_user: { id: 7, first_name: "原作者", is_bot: false },
          },
        }),
        options,
        hidden,
      ),
    ).toEqual({ reason: "privacy" });
  });
  it("uses original dates and durable reset boundaries for recaptured old replies", async () => {
    const p = privacy({ getQuoteResetAt: vi.fn().mockResolvedValue(100000) });
    expect(await captureQuoteSource(message(), options, p)).toEqual({ reason: "privacy" });
    expect(await captureQuoteSource(message({ date: undefined }), options, p)).toEqual({
      reason: "privacy",
    });
    const result = await captureQuoteSource(message({ date: 101 }), options, p);
    expect(result).toHaveProperty("source");
    if ("source" in result)
      expect(
        await isQuoteSourceAllowed(
          result.source,
          privacy({ getMode: vi.fn().mockResolvedValue("off") }),
        ),
      ).toBe(false);
  });
});
