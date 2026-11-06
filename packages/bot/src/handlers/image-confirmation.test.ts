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
      port: { editConfirmation } as unknown as ImageGenerationPort,
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
      port: { confirm } as unknown as ImageGenerationPort,
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
    expect(confirm).toHaveBeenCalledWith(expect.objectContaining({ userId: 7 }), generation.id);
    expect(api.editMessageText).toHaveBeenLastCalledWith(
      12,
      99,
      expect.stringContaining("已确认"),
      { reply_markup: { inline_keyboard: [] } },
    );
  });

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
      port: { cancelConfirmation } as unknown as ImageGenerationPort,
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
      reply_markup: { inline_keyboard: [] },
    });
  });
});
