import { Readable } from "node:stream";
import { access } from "node:fs/promises";
import { autoRetry } from "@grammyjs/auto-retry";
import { Api, InputFile, type Transformer } from "grammy";
import sharp from "sharp";
import { describe, expect, it, vi } from "vitest";
import { NsfwChecker } from "./nsfw-checker.js";
import { createOutgoingImageSafety } from "./outgoing-image-safety.js";

const safe = {
  status: "checked" as const,
  isNsfw: false,
  scores: { porn: 0, sexy: 0, hentai: 0, neutral: 1, drawing: 0 },
};
const unsafe = { ...safe, isNsfw: true, scores: { ...safe.scores, porn: 0.9, neutral: 0.1 } };
const jpeg = () =>
  sharp({ create: { width: 8, height: 8, channels: 3, background: "white" } })
    .jpeg()
    .toBuffer();
function setup(configured = true, retry = false) {
  const api = new Api("test-token");
  const transport = vi.fn(async (_prev, method, _payload) => ({
    ok: true,
    result:
      method === "getFile"
        ? { file_path: "photos/image.jpg", file_size: 100 }
        : method === "sendMediaGroup"
          ? [{ message_id: 1 }, { message_id: 2 }]
          : { message_id: 1 },
  }));
  api.config.use(transport as Transformer);
  if (retry) api.config.use(autoRetry());
  const checker = {
    readImageUrl: vi.fn().mockResolvedValue(new Uint8Array([1, 2, 3])),
    checkImageBytes: vi.fn().mockResolvedValue(safe),
  } as unknown as NsfwChecker;
  api.config.use(
    createOutgoingImageSafety({
      api,
      token: "test-token",
      checker: configured ? checker : undefined,
    }),
  );
  return { api, checker, transport };
}
function payloadOf(transport: ReturnType<typeof setup>["transport"], method: string) {
  return transport.mock.calls.find((call) => call[1] === method)![2];
}

describe("outgoing image safety", () => {
  it("classifies the exact URL bytes sent to Telegram and refuses a caller's false spoiler override", async () => {
    const { api, checker, transport } = setup();
    vi.mocked(checker.checkImageBytes).mockResolvedValue(unsafe);
    await api.sendPhoto(42, "https://images.test/image.jpg", {
      has_spoiler: false,
      caption: "caption",
    });
    const payload = payloadOf(transport, "sendPhoto");
    expect(payload).toMatchObject({ has_spoiler: true, caption: "caption" });
    expect(await (payload.photo as InputFile).toRaw()).toEqual(new Uint8Array([1, 2, 3]));
  });
  it("leaves a verified safe photo visible", async () => {
    const { api, transport } = setup();
    await api.sendPhoto(42, "https://images.test/image.jpg");
    expect(payloadOf(transport, "sendPhoto").has_spoiler).toBe(false);
  });
  it("preserves explicit spoilers without a redundant classifier call", async () => {
    const { api, checker, transport } = setup();
    await api.sendPhoto(42, "https://images.test/image.jpg", { has_spoiler: true });
    expect(checker.checkImageBytes).not.toHaveBeenCalled();
    expect(payloadOf(transport, "sendPhoto").has_spoiler).toBe(true);
  });
  it("covers all photos when the classifier is not configured", async () => {
    const { api, transport } = setup(false);
    await api.sendPhoto(42, "photo-file-id");
    expect(payloadOf(transport, "sendPhoto").has_spoiler).toBe(true);
    expect(transport).toHaveBeenCalledOnce();
  });
  it("checks every album photo and covers the batch on classification failure", async () => {
    const { api, checker, transport } = setup();
    vi.mocked(checker.checkImageBytes)
      .mockResolvedValueOnce(safe)
      .mockResolvedValueOnce({ status: "failed", isNsfw: true, scores: null });
    await api.sendMediaGroup(42, [
      { type: "photo", media: "https://images.test/one" },
      { type: "photo", media: "https://images.test/two" },
    ]);
    expect(
      payloadOf(transport, "sendMediaGroup").media.map(
        (media: { has_spoiler: boolean }) => media.has_spoiler,
      ),
    ).toEqual([true, true]);
  });
  it.each([
    [0.49, false],
    [0.5, true],
    [0.9, true],
  ])(
    "checks the whole album before applying its combined score decision (%s)",
    async (score, hasSpoiler) => {
      const { api, checker, transport } = setup();
      vi.mocked(checker.checkImageBytes)
        .mockResolvedValueOnce({
          ...safe,
          scores: { ...safe.scores, porn: score, neutral: 1 - score },
        })
        .mockResolvedValueOnce(safe);
      await api.sendMediaGroup(42, [
        { type: "photo", media: "https://images.test/one" },
        { type: "photo", media: "https://images.test/two" },
      ]);
      expect(checker.checkImageBytes).toHaveBeenCalledTimes(2);
      expect(payloadOf(transport, "sendMediaGroup").media).toEqual([
        expect.objectContaining({ has_spoiler: hasSpoiler }),
        expect.objectContaining({ has_spoiler: hasSpoiler }),
      ]);
    },
  );

  it("protects replacement photos", async () => {
    const { api, checker, transport } = setup();
    vi.mocked(checker.checkImageBytes).mockResolvedValue(unsafe);
    await api.editMessageMedia(42, 1, { type: "photo", media: "https://images.test/replacement" });
    expect(payloadOf(transport, "editMessageMedia").media.has_spoiler).toBe(true);
  });
  it("resolves Telegram file ids before checking the saved bytes", async () => {
    const { api, checker, transport } = setup();
    await api.sendPhoto(42, "photo-file-id");
    expect(checker.readImageUrl).toHaveBeenCalledWith(
      "https://api.telegram.org/file/bottest-token/photos/image.jpg",
      expect.anything(),
    );
    expect(payloadOf(transport, "sendPhoto").photo).toBeInstanceOf(InputFile);
  });
  it("rebuilds one-shot InputFile streams so checked bytes remain sendable", async () => {
    const { api, checker, transport } = setup();
    vi.mocked(checker.checkImageBytes).mockResolvedValue(unsafe);
    await api.sendPhoto(
      42,
      new InputFile(Readable.from([Buffer.from([1, 2]), Buffer.from([3])]), "image.png"),
    );
    const photo = payloadOf(transport, "sendPhoto").photo as InputFile;
    expect(await photo.toRaw()).toEqual(Buffer.from([1, 2, 3]));
    expect(await photo.toRaw()).toEqual(Buffer.from([1, 2, 3]));
  });
  it("blocks unsafe image documents and static stickers that cannot carry a spoiler", async () => {
    const { api, checker, transport } = setup();
    vi.mocked(checker.checkImageBytes).mockResolvedValue(unsafe);
    await expect(api.sendDocument(42, new InputFile(await jpeg()))).rejects.toThrow("send_photo");
    await expect(api.sendSticker(42, new InputFile(await jpeg()))).rejects.toThrow("send_photo");
    expect(transport).not.toHaveBeenCalled();
  });
  it("blocks anonymous image documents when classification is unavailable", async () => {
    const { api, transport } = setup(false);
    await expect(api.sendDocument(42, new InputFile(await jpeg()))).rejects.toThrow("send_photo");
    expect(transport).not.toHaveBeenCalled();
  });
  it("detects an image disguised with a document filename", async () => {
    const { api, checker, transport } = setup();
    vi.mocked(checker.checkImageBytes).mockResolvedValue(unsafe);
    await expect(api.sendDocument(42, new InputFile(await jpeg(), "report.txt"))).rejects.toThrow(
      "send_photo",
    );
    expect(checker.checkImageBytes).toHaveBeenCalledOnce();
    expect(transport).not.toHaveBeenCalled();
  });
  it("replays a streamed document intact across real autoRetry rate-limit handling", async () => {
    const { api, transport } = setup(true, true);
    const document = new InputFile(
      Readable.from([Buffer.alloc(512, 97), Buffer.alloc(1024, 98)]),
      "report.txt",
    );
    const sizes: number[] = [];
    let stagedPath = "";
    transport.mockImplementation(async (_prev, _method, payload) => {
      const sent = payload.document as InputFile;
      const raw = (await sent.toRaw()) as import("node:fs").ReadStream;
      stagedPath = String(raw.path);
      let size = 0;
      for await (const chunk of raw as AsyncIterable<Uint8Array>) size += chunk.byteLength;
      sizes.push(size);
      return sizes.length === 1
        ? ({
            ok: false,
            error_code: 429,
            description: "Too Many Requests",
            parameters: { retry_after: 0 },
          } as never)
        : { ok: true, result: { message_id: 1 } };
    });
    await api.sendDocument(42, document);
    expect(sizes).toEqual([1536, 1536]);
    expect(transport).toHaveBeenCalledTimes(2);
    await expect(access(stagedPath)).rejects.toMatchObject({ code: "ENOENT" });
  });
  it("allows non-image document uploads to outlast the detection deadline", async () => {
    const { api, transport } = setup();
    let resume!: () => void;
    let awaitingTail = false;
    const waiting = new Promise<void>((resolve) => {
      resume = resolve;
    });
    const source = (async function* () {
      yield Buffer.alloc(512, 97);
      awaitingTail = true;
      await waiting;
      yield Buffer.alloc(1024, 98);
    })();
    let size = 0;
    transport.mockImplementationOnce(async (_prev, _method, payload) => {
      for await (const chunk of (await (
        payload.document as InputFile
      ).toRaw()) as AsyncIterable<Uint8Array>)
        size += chunk.byteLength;
      return { ok: true, result: { message_id: 1 } };
    });
    vi.useFakeTimers();
    try {
      const sending = api.sendDocument(42, new InputFile(source, "report.txt"));
      await vi.waitFor(() => expect(awaitingTail).toBe(true));
      await vi.advanceTimersByTimeAsync(11_000);
      resume();
      await sending;
      expect(size).toBe(1536);
    } finally {
      resume();
      vi.useRealTimers();
    }
  });
  it("closes a handed-off document stream if a later album image is refused", async () => {
    const { api, checker, transport } = setup();
    vi.mocked(checker.checkImageBytes).mockResolvedValue(unsafe);
    const source = Readable.from([Buffer.alloc(512, 97), Buffer.alloc(1024, 98)]);
    await expect(
      api.sendMediaGroup(42, [
        { type: "document", media: new InputFile(source, "report.txt") },
        { type: "document", media: new InputFile(await jpeg(), "image.jpg") },
      ]),
    ).rejects.toThrow("send_photo");
    await vi.waitFor(() => expect(source.destroyed).toBe(true));
    expect(transport).not.toHaveBeenCalled();
  });
  it("retries a URL document from the same staged bytes without downloading it again", async () => {
    const { api, checker, transport } = setup(true, true);
    const download = vi.fn().mockResolvedValue(new Response("a".repeat(1536)));
    Object.assign(checker, { openImageUrl: download });
    const sizes: number[] = [];
    transport.mockImplementation(async (_prev, _method, payload) => {
      let size = 0;
      for await (const chunk of (await (
        payload.document as InputFile
      ).toRaw()) as AsyncIterable<Uint8Array>)
        size += chunk.byteLength;
      sizes.push(size);
      return sizes.length === 1
        ? ({
            ok: false,
            error_code: 429,
            description: "Too Many Requests",
            parameters: { retry_after: 0 },
          } as never)
        : { ok: true, result: { message_id: 1 } };
    });
    await api.sendDocument(42, "https://files.test/report.txt");
    expect(sizes).toEqual([1536, 1536]);
    expect(download).toHaveBeenCalledOnce();
    expect(checker.checkImageBytes).not.toHaveBeenCalled();
  });
  it("rejects oversized non-image documents before sending them", async () => {
    const { api, transport } = setup();
    await expect(
      api.sendDocument(
        42,
        new InputFile(Readable.from([new Uint8Array(50_000_001)]), "report.txt"),
      ),
    ).rejects.toThrow("Telegram size limit");
    expect(transport).not.toHaveBeenCalled();
  });
  it("keeps large non-image attachments on their original delivery path", async () => {
    const { api, checker, transport } = setup();
    const document = new InputFile(new Uint8Array(21 * 1024 * 1024), "report.pdf");
    await api.sendDocument(42, document);
    expect(checker.checkImageBytes).not.toHaveBeenCalled();
    const raw = await (payloadOf(transport, "sendDocument").document as InputFile).toRaw();
    let bytes = raw instanceof Uint8Array ? raw.byteLength : 0;
    if (!(raw instanceof Uint8Array))
      for await (const chunk of raw as AsyncIterable<Uint8Array>) bytes += chunk.byteLength;
    expect(bytes).toBe(21 * 1024 * 1024);
  });
  it("covers rich markdown references, HTML photos and nested photo blocks", async () => {
    const { api, checker, transport } = setup();
    await api.sendRichMessage(42, {
      markdown:
        '![art][ref]\n\n[ref]: https://images.test/image.jpg\n\n<img src="https://images.test/two.jpg"/>',
    });
    const markdown = payloadOf(transport, "sendRichMessage").rich_message.markdown;
    expect(markdown).not.toContain("![art]");
    expect(markdown.match(/tg-spoiler/g)).toHaveLength(2);
    vi.mocked(checker.checkImageBytes).mockResolvedValue(unsafe);
    await api.sendRichMessageDraft(42, 1, {
      blocks: [
        {
          type: "details",
          summary: "More",
          blocks: [
            { type: "photo", photo: { type: "photo", media: "https://images.test/one.jpg" } },
          ],
        },
      ],
    });
    expect(
      payloadOf(transport, "sendRichMessageDraft").rich_message.blocks[0].blocks[0].photo
        .has_spoiler,
    ).toBe(true);
  });
  it("disables image-bearing link previews even when explicitly requested", async () => {
    const { api, transport } = setup();
    await api.sendMessage(42, "https://images.test/image.jpg", {
      link_preview_options: { is_disabled: false },
    });
    expect(payloadOf(transport, "sendMessage").link_preview_options).toEqual({ is_disabled: true });
  });
  it("never sends after cancellation during classification", async () => {
    const { api, checker, transport } = setup();
    const controller = new AbortController();
    vi.mocked(checker.checkImageBytes).mockImplementation(async () => {
      controller.abort();
      return safe;
    });
    await expect(
      api.raw.sendPhoto(
        { chat_id: 42, photo: "https://images.test/one.jpg" },
        controller.signal as never,
      ),
    ).rejects.toThrow();
    expect(transport).not.toHaveBeenCalled();
  });
});
