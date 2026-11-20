import { describe, expect, it, vi } from "vitest";
import type { ImageGenerationPort, ImageGenerationView } from "@cos-tool-bot/shared";
import {
  createImageConfirmationCallbackQueryHandler,
  imageConfirmationText,
} from "./image-confirmation.js";

const generation: ImageGenerationView = {
  id: "00000000-0000-4000-8000-000000000001",
  purpose: "anime_illustration",
  provider: "mcp_pixai",
  state: "awaiting_approval",
  approval: "required",
  deliveryTarget: { chatId: 12 },
  confirmationVersion: 1,
  confirmationSeed: 1,
  artifacts: [],
  createdAt: "2026-11-06T00:00:00.000Z",
  updatedAt: "2026-11-06T00:00:00.000Z",
};

describe("image generation confirmation", () => {
  it("renders immutable snapshot version and draft seed", () => {
    expect(imageConfirmationText(generation)).toContain("确认版本：v1");
    expect(imageConfirmationText(generation)).toContain("Seed：1");
  });

  it("quotes both prompts as text, shows parameters and bounds long Unicode previews", () => {
    const preview = {
      prompt: "<tag> & 🐈",
      negativePrompt: "模糊",
      size: "1024x1536",
      aspectRatio: "2:3",
      quality: "high",
    };
    const text = imageConfirmationText({ ...generation, confirmationPreview: preview });
    for (const part of [
      "<blockquote expandable>&lt;tag&gt; &amp; 🐈</blockquote>",
      "负面提示词",
      "模糊",
      "1024x1536",
      "2:3",
      "high",
    ])
      expect(text).toContain(part);
    const long = imageConfirmationText({
      ...generation,
      confirmationPreview: { prompt: "🐈".repeat(8000), negativePrompt: "🐈".repeat(4000) },
    });
    expect(long).toContain("共 8000 字符");
    expect(long).toContain("共 4000 字符");
    expect(long.length).toBeLessThan(4096);
  });

  it("lets the initiating user edit a draft without confirming it", async () => {
    const editConfirmation = vi.fn(async () => ({
      ...generation,
      confirmationVersion: 2,
      confirmationSeed: 42,
    }));
    const api = {
      raw: { answerCallbackQuery: vi.fn().mockResolvedValue(true) },
      editMessageText: vi.fn().mockResolvedValue(true),
    };
    const handler = createImageConfirmationCallbackQueryHandler({
      api: api as never,
      botId: "bot",
      adminIds: [],
      port: {
        get: vi.fn().mockResolvedValue(generation),
        editConfirmation,
      } as unknown as ImageGenerationPort,
    });
    await expect(
      handler({
        callbackQuery: {
          id: "query",
          data: `cos:image:${generation.id}:edit`,
          from: { id: 7 },
          message: { chat: { id: 12 }, message_id: 99 },
        },
      }),
    ).resolves.toBe(true);
    expect(editConfirmation).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 7 }),
      generation.id,
      { seed: expect.any(Number) },
    );
    expect(api.editMessageText).toHaveBeenCalledWith(
      12,
      99,
      expect.stringContaining("重新确认"),
      expect.any(Object),
    );
  });

  it("confirms a pending generation and clears the card actions", async () => {
    const confirm = vi.fn(async () => ({ accepted: true as const, generation }));
    const api = {
      raw: { answerCallbackQuery: vi.fn().mockResolvedValue(true) },
      editMessageText: vi.fn().mockResolvedValue(true),
    };
    const handler = createImageConfirmationCallbackQueryHandler({
      api: api as never,
      botId: "bot",
      adminIds: [],
      port: {
        get: vi.fn().mockResolvedValue(generation),
        confirm,
      } as unknown as ImageGenerationPort,
    });

    await expect(
      handler({
        callbackQuery: {
          id: "query",
          data: `cos:image:${generation.id}:confirm`,
          from: { id: 7 },
          message: { chat: { id: 12 }, message_id: 99 },
        },
      }),
    ).resolves.toBe(true);
    expect(confirm).toHaveBeenCalledWith(expect.objectContaining({ userId: 7 }), generation.id, 1);
    expect(api.editMessageText).toHaveBeenLastCalledWith(
      12,
      99,
      expect.stringContaining("已确认"),
      { parse_mode: "HTML", reply_markup: { inline_keyboard: [] } },
    );
  });

  it.each(["confirm", "confirm:1"])(
    "requires another click after refreshing a stale %s button",
    async (button) => {
      const latest = {
        ...generation,
        confirmationVersion: 2,
        confirmationPreview: { prompt: "new draft" },
      };
      const confirm = vi.fn().mockResolvedValue({ accepted: true, generation: latest });
      const api = {
        raw: { answerCallbackQuery: vi.fn() },
        editMessageText: vi.fn().mockResolvedValue(true),
      };
      const handler = createImageConfirmationCallbackQueryHandler({
        api: api as never,
        botId: "bot",
        adminIds: [],
        port: { get: vi.fn().mockResolvedValue(latest), confirm } as unknown as ImageGenerationPort,
      });
      const query = {
        id: "query",
        data: `cos:image:${generation.id}:${button}`,
        from: { id: 7 },
        message: { chat: { id: 12 }, message_id: 99 },
      };
      await handler({ callbackQuery: query });
      expect(confirm).not.toHaveBeenCalled();
      expect(api.editMessageText).toHaveBeenCalledWith(
        12,
        99,
        expect.stringContaining("new draft"),
        expect.objectContaining({
          reply_markup: {
            inline_keyboard: [
              expect.arrayContaining([
                { text: "确认生成", callback_data: `cos:image:${generation.id}:confirm:2` },
              ]),
            ],
          },
        }),
      );
      await handler({ callbackQuery: { ...query, data: `cos:image:${generation.id}:confirm:2` } });
      expect(confirm).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({ userId: 7 }),
        generation.id,
        2,
      );
    },
  );

  it.each([
    { chat: 11, topic: 73, operationId: undefined },
    { chat: 12, topic: 74, operationId: undefined },
    { chat: 12, topic: 73, operationId: "provider-op" },
  ])(
    "rejects a mismatched chat, topic or provider approval (%o)",
    async ({ chat, topic, operationId }) => {
      const api = { raw: { answerCallbackQuery: vi.fn() }, editMessageText: vi.fn() };
      const confirm = vi.fn();
      const data = {
        ...generation,
        providerOperationId: operationId,
        deliveryTarget: { chatId: 12, threadId: 73 },
        confirmationPreview: { prompt: "private" },
      };
      const handler = createImageConfirmationCallbackQueryHandler({
        api: api as never,
        botId: "bot",
        adminIds: [7],
        port: { get: vi.fn().mockResolvedValue(data), confirm } as unknown as ImageGenerationPort,
      });
      for (const action of ["edit_prompt", "confirm:1"]) {
        await handler({
          callbackQuery: {
            id: "query",
            data: `cos:image:${generation.id}:${action}`,
            from: { id: 7 },
            message: {
              chat: { id: chat },
              message_id: 99,
              message_thread_id: topic,
              is_topic_message: true,
            },
          },
        });
      }
      expect(api.editMessageText).not.toHaveBeenCalled();
      expect(confirm).not.toHaveBeenCalled();
      expect(api.raw.answerCallbackQuery).toHaveBeenCalledWith(
        expect.objectContaining({ show_alert: true }),
      );
    },
  );

  it("cancels a pending generation and reports a failed cancellation", async () => {
    const cancelConfirmation = vi.fn(async () => ({
      ok: false as const,
      reason: "terminal" as const,
      message: "已经处理",
    }));
    const api = {
      raw: { answerCallbackQuery: vi.fn().mockResolvedValue(true) },
      editMessageText: vi.fn().mockResolvedValue(true),
    };
    const handler = createImageConfirmationCallbackQueryHandler({
      api: api as never,
      botId: "bot",
      adminIds: [],
      port: {
        get: vi.fn().mockResolvedValue(generation),
        cancelConfirmation,
      } as unknown as ImageGenerationPort,
    });

    await expect(
      handler({
        callbackQuery: {
          id: "query",
          data: `cos:image:${generation.id}:cancel`,
          from: { id: 7 },
          message: { chat: { id: 12 }, message_id: 99 },
        },
      }),
    ).resolves.toBe(true);
    expect(api.editMessageText).toHaveBeenLastCalledWith(12, 99, "❌ 已经处理", {
      parse_mode: "HTML",
      reply_markup: { inline_keyboard: [] },
    });
  });
});
