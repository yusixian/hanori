import type { BotContext } from "../context.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createAiReplyHandler, type AiReplyConfig } from "./ai-reply.js";

const { describeImagesMock, streamTextMock } = vi.hoisted(() => ({
  describeImagesMock: vi.fn(),
  streamTextMock: vi.fn(),
}));

vi.mock("ai", async (importOriginal) => ({
  ...(await importOriginal<typeof import("ai")>()),
  streamText: streamTextMock,
}));

vi.mock("../services/image-ocr.js", () => ({ describeImages: describeImagesMock }));

const runtimes: Array<ReturnType<typeof createAiReplyHandler>> = [];

function streamResult(text = "看到了") {
  async function* textStream() {
    yield text;
  }
  return {
    textStream: textStream(),
    text: Promise.resolve(text),
    steps: Promise.resolve([]),
    usage: Promise.resolve({ inputTokens: 1, outputTokens: 1, totalTokens: 2 }),
    finishReason: Promise.resolve("stop"),
  };
}

function config(): AiReplyConfig {
  return {
    botId: "bot-1",
    apiKey: "key",
    baseURL: "https://example.com/v1",
    model: "text-only-model-id",
    models: [{ id: "text-only-model-id", capabilities: ["tool_calling"] }],
    systemPrompt: "system",
    triggerConfig: {
      replyToBot: true,
      mentionBot: true,
      triggerWords: ["sample"],
      randomReplyPercent: 0,
      randomReplyCooldown: 60,
    },
    groupOverrides: {},
    adminChatIds: [],
    privateChatAccess: "allowlist",
    privateChatWhitelist: [42],
    token: "token",
  };
}

function visionConfig(): AiReplyConfig {
  const result = config();
  result.models = [{ id: "text-only-model-id", capabilities: ["vision", "tool_calling"] }];
  return result;
}

function sticker(
  format: "static" | "animated" | "video" = "static",
  metadata: { emoji?: string; setName?: string } | null = {},
) {
  const emoji = metadata === null ? undefined : (metadata.emoji ?? "😭");
  const setName = metadata === null ? undefined : (metadata.setName ?? "sample_reactions");
  return {
    file_id: `${format}-sticker-id`,
    file_unique_id: `${format}-sticker-unique-id`,
    type: "regular" as const,
    width: 512,
    height: 512,
    file_size: 24 * 1024,
    is_animated: format === "animated",
    is_video: format === "video",
    ...(emoji ? { emoji } : {}),
    ...(setName ? { set_name: setName } : {}),
  };
}

function photoContext(getFile: ReturnType<typeof vi.fn>): BotContext {
  return {
    message: {
      message_id: 7,
      caption: "分析这张图",
      photo: [
        {
          file_id: "photo-large",
          file_unique_id: "photo-large-unique",
          width: 1024,
          height: 1024,
          file_size: 182 * 1024,
        },
      ],
    },
    chat: { id: 42, type: "private" },
    from: { id: 42, is_bot: false, first_name: "Tester" },
    me: { id: 99, is_bot: true, first_name: "Ai", username: "sample_bot" },
    api: { getFile },
    replyWithChatAction: vi.fn(),
    wait: vi.fn().mockResolvedValue(undefined),
    resolveWait: vi.fn().mockResolvedValue(20),
    deleteWaiting: vi.fn(),
    directlyReply: vi.fn(),
  } as unknown as BotContext;
}

function stickerContext(
  getFile: ReturnType<typeof vi.fn>,
  format: "static" | "animated" | "video" = "static",
  metadata: { emoji?: string; setName?: string } | null = {},
): BotContext {
  return {
    message: {
      message_id: 8,
      sticker: sticker(format, metadata),
    },
    chat: { id: 42, type: "private" },
    from: { id: 42, is_bot: false, first_name: "Tester" },
    me: { id: 99, is_bot: true, first_name: "Ai", username: "sample_bot" },
    api: { getFile },
    replyWithChatAction: vi.fn(),
    wait: vi.fn().mockResolvedValue(undefined),
    resolveWait: vi.fn().mockResolvedValue(20),
    deleteWaiting: vi.fn(),
    directlyReply: vi.fn(),
  } as unknown as BotContext;
}

function stickerReplyContext(getFile: ReturnType<typeof vi.fn>): BotContext {
  return {
    message: { message_id: 9, text: "看看这个贴纸" },
    reply_to_message: {
      message_id: 7,
      from: { id: 7, is_bot: false, first_name: "Friend" },
      sticker: sticker(),
    },
    chat: { id: 42, type: "private" },
    from: { id: 42, is_bot: false, first_name: "Tester" },
    me: { id: 99, is_bot: true, first_name: "Ai", username: "sample_bot" },
    api: { getFile },
    replyWithChatAction: vi.fn(),
    wait: vi.fn().mockResolvedValue(undefined),
    resolveWait: vi.fn().mockResolvedValue(20),
    deleteWaiting: vi.fn(),
    directlyReply: vi.fn(),
  } as unknown as BotContext;
}

describe("AI reply vision input", () => {
  beforeEach(() => {
    describeImagesMock.mockReset();
    streamTextMock.mockReset();
    streamTextMock.mockReturnValue(streamResult());
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(new Uint8Array([0xff, 0xd8, 0xff]), {
          status: 200,
          headers: { "content-type": "image/jpeg" },
        }),
      ),
    );
  });

  afterEach(async () => {
    await Promise.allSettled(runtimes.splice(0).map((runtime) => runtime.destroy()));
    vi.unstubAllGlobals();
  });

  it("passes Telegram photos to the model even without a vision capability flag", async () => {
    const getFile = vi.fn().mockResolvedValue({ file_path: "photos/example.jpg" });
    const runtime = createAiReplyHandler(config());
    runtimes.push(runtime);

    await runtime.handler(photoContext(getFile), vi.fn());

    expect(getFile).toHaveBeenCalledWith("photo-large");
    expect(streamTextMock.mock.calls[0]?.[0]?.messages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          role: "user",
          content: expect.arrayContaining([
            expect.objectContaining({ type: "image", mediaType: "image/jpeg" }),
          ]),
        }),
      ]),
    );
  });

  it("allows private chats by default without an allowlist", async () => {
    const getFile = vi.fn().mockResolvedValue({ file_path: "photos/example.jpg" });
    const runtimeConfig = config();
    runtimeConfig.privateChatAccess = undefined;
    runtimeConfig.privateChatWhitelist = [];
    const runtime = createAiReplyHandler(runtimeConfig);
    runtimes.push(runtime);

    await runtime.handler(photoContext(getFile), vi.fn());

    expect(streamTextMock).toHaveBeenCalledOnce();
  });

  it("can restrict private chats to administrators", async () => {
    const getFile = vi.fn().mockResolvedValue({ file_path: "photos/example.jpg" });
    const runtimeConfig = config();
    runtimeConfig.privateChatAccess = "admin";
    const runtime = createAiReplyHandler(runtimeConfig);
    runtimes.push(runtime);

    await runtime.handler(photoContext(getFile), vi.fn());

    expect(streamTextMock).not.toHaveBeenCalled();
    expect(getFile).not.toHaveBeenCalled();
  });

  it("logs when a configured image size limit skips model input", async () => {
    const getFile = vi.fn().mockResolvedValue({ file_path: "photos/example.jpg" });
    const onLog = vi.fn();
    const runtimeConfig = config();
    runtimeConfig.imageOcrConfig = { enabled: false, maxInputImageBytes: 2 };
    runtimeConfig.onLog = onLog;
    const runtime = createAiReplyHandler(runtimeConfig);
    runtimes.push(runtime);

    await runtime.handler(photoContext(getFile), vi.fn());

    expect(onLog).toHaveBeenCalledWith(
      expect.objectContaining({
        level: "warn",
        message: expect.stringContaining("image skipped"),
        meta: { fileId: "photo-large", size: 3, limit: 2 },
      }),
    );
    expect(JSON.stringify(streamTextMock.mock.calls[0]?.[0]?.messages)).not.toContain(
      '"type":"image"',
    );
  });

  it("keeps the original photo and adds its configured description as text context", async () => {
    const getFile = vi.fn().mockResolvedValue({ file_path: "photos/example.jpg" });
    const runtimeConfig = config();
    runtimeConfig.imageOcrConfig = { enabled: true };
    describeImagesMock.mockResolvedValue([
      { description: "蓝白色裙装人物站在夜色花丛中，背景有向日葵和星光。" },
    ]);
    const runtime = createAiReplyHandler(runtimeConfig);
    runtimes.push(runtime);

    await runtime.handler(photoContext(getFile), vi.fn());

    expect(describeImagesMock).toHaveBeenCalledWith(
      expect.objectContaining({
        images: [expect.objectContaining({ mimeType: "image/jpeg" })],
      }),
    );
    expect(streamTextMock.mock.calls[0]?.[0]?.messages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          role: "user",
          content: expect.arrayContaining([
            expect.objectContaining({ type: "image", mediaType: "image/jpeg" }),
            expect.objectContaining({
              type: "text",
              text: expect.stringContaining(
                "描述: 蓝白色裙装人物站在夜色花丛中，背景有向日葵和星光。",
              ),
            }),
          ]),
        }),
      ]),
    );
  });

  it("passes a directly sent static sticker through vision and OCR with its metadata", async () => {
    const getFile = vi.fn().mockResolvedValue({ file_path: "stickers/reaction.webp" });
    const runtimeConfig = visionConfig();
    runtimeConfig.imageOcrConfig = { enabled: true };
    const addMessages = vi.fn().mockResolvedValue(undefined);
    runtimeConfig.conversation = {
      getHistory: vi.fn().mockResolvedValue({ summary: null, messages: [] }),
      addMessage: vi.fn().mockResolvedValue(undefined),
      addMessages,
      triggerCompression: vi.fn(),
      clearHistory: vi.fn().mockResolvedValue(undefined),
    };
    describeImagesMock.mockResolvedValue([{ description: "角色流泪并捂住脸。" }]);
    const runtime = createAiReplyHandler(runtimeConfig);
    runtimes.push(runtime);

    await runtime.handler(stickerContext(getFile), vi.fn());

    expect(getFile).toHaveBeenCalledWith("static-sticker-id");
    expect(describeImagesMock).toHaveBeenCalledWith(
      expect.objectContaining({
        images: [expect.objectContaining({ mimeType: "image/webp" })],
      }),
    );
    const messages = streamTextMock.mock.calls[0]?.[0]?.messages;
    expect(messages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          role: "user",
          content: expect.arrayContaining([
            expect.objectContaining({ type: "image", mediaType: "image/webp" }),
            expect.objectContaining({
              type: "text",
              text: expect.stringContaining(
                '[收到贴纸 24KB | emoji: 😭 | set: "sample_reactions" | 格式: 静态 WEBP | 描述: 角色流泪并捂住脸。]',
              ),
            }),
          ]),
        }),
      ]),
    );
    expect(
      addMessages.mock.calls.flatMap(([rows]) => rows).find((row) => row.role === "user")?.content,
    ).toContain('emoji: 😭 | set: "sample_reactions" | 格式: 静态 WEBP');
  });

  it("passes a quoted static sticker to vision and keeps its metadata in the reply quote", async () => {
    const getFile = vi.fn().mockResolvedValue({ file_path: "stickers/reaction.webp" });
    const runtime = createAiReplyHandler(visionConfig());
    runtimes.push(runtime);

    await runtime.handler(stickerReplyContext(getFile), vi.fn());

    expect(getFile).toHaveBeenCalledWith("static-sticker-id");
    const messages = streamTextMock.mock.calls[0]?.[0]?.messages;
    expect(messages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          role: "user",
          content: expect.arrayContaining([
            expect.objectContaining({ type: "image", mediaType: "image/webp" }),
            expect.objectContaining({
              type: "text",
              text: expect.stringContaining(
                '[回复 Friend 的消息: [贴纸 24KB | emoji: 😭 | set: "sample_reactions" | 格式: 静态 WEBP]]',
              ),
            }),
          ]),
        }),
      ]),
    );
  });

  it.each([
    ["animated" as const, "动态 TGS"],
    ["video" as const, "视频 WEBM"],
  ])("keeps %s stickers as metadata without downloading them", async (format, label) => {
    const getFile = vi.fn();
    const runtime = createAiReplyHandler(visionConfig());
    runtimes.push(runtime);

    await runtime.handler(stickerContext(getFile, format), vi.fn());

    expect(getFile).not.toHaveBeenCalled();
    const messages = streamTextMock.mock.calls[0]?.[0]?.messages;
    expect(JSON.stringify(messages)).not.toContain('"type":"image"');
    expect(JSON.stringify(messages)).toContain(
      `emoji: 😭 | set: \\"sample_reactions\\" | 格式: ${label}`,
    );
  });

  it("handles a sticker with no emoji or set name", async () => {
    const getFile = vi.fn();
    const runtime = createAiReplyHandler(visionConfig());
    runtimes.push(runtime);

    await runtime.handler(stickerContext(getFile, "animated", null), vi.fn());

    expect(getFile).not.toHaveBeenCalled();
    const currentRequest = JSON.stringify(streamTextMock.mock.calls[0]?.[0]?.messages?.at(-1));
    expect(currentRequest).toContain("[收到贴纸 24KB | 格式: 动态 TGS]");
    expect(currentRequest).not.toContain("emoji:");
    expect(currentRequest).not.toContain("set:");
  });

  it("passes a static sticker to the model even without a vision capability flag", async () => {
    const getFile = vi.fn().mockResolvedValue({ file_path: "stickers/reaction.webp" });
    const runtime = createAiReplyHandler(config());
    runtimes.push(runtime);

    await runtime.handler(stickerContext(getFile), vi.fn());

    expect(getFile).toHaveBeenCalledWith("static-sticker-id");
    const messages = streamTextMock.mock.calls[0]?.[0]?.messages;
    expect(JSON.stringify(messages)).toContain('"type":"image"');
    expect(JSON.stringify(messages)).toContain("emoji: 😭");
    expect(JSON.stringify(messages)).toContain("格式: 静态 WEBP");
  });

  it("does not expose the previous photo as the current attachment after a sticker", async () => {
    const getFile = vi.fn().mockResolvedValue({ file_path: "photos/example.jpg" });
    const runtimeConfig = config();
    runtimeConfig.dataFiles = {
      dataDir: "/tmp/cos-tool-bot-sticker-test",
      injectableFiles: new Set(),
      loadFiles: vi.fn().mockResolvedValue([]),
    };
    const runtime = createAiReplyHandler(runtimeConfig);
    runtimes.push(runtime);

    await runtime.handler(photoContext(getFile), vi.fn());
    await runtime.handler(stickerContext(getFile), vi.fn());

    expect(getFile).toHaveBeenCalledTimes(2);
    expect(getFile).toHaveBeenLastCalledWith("static-sticker-id");
    const saveReceivedFile = streamTextMock.mock.calls[1]?.[0]?.tools?.save_received_file;
    await expect(
      saveReceivedFile?.execute?.({ index: 0, filename: "stale.jpg" }, {} as never),
    ).resolves.toEqual({ error: "当前没有收到文件附件" });
  });

  it("falls back to sticker metadata when the static image download fails", async () => {
    const getFile = vi.fn().mockRejectedValue(new Error("Telegram unavailable"));
    const runtime = createAiReplyHandler(visionConfig());
    runtimes.push(runtime);

    await runtime.handler(stickerContext(getFile), vi.fn());

    const messages = streamTextMock.mock.calls[0]?.[0]?.messages;
    expect(JSON.stringify(messages)).not.toContain('"type":"image"');
    expect(JSON.stringify(messages)).toContain("emoji: 😭");
    expect(streamTextMock).toHaveBeenCalledOnce();
  });
});
