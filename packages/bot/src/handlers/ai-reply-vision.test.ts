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
    privateChatWhitelist: [42],
    token: "token",
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
});
