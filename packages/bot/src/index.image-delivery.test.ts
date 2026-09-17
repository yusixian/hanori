import type { Api } from "grammy";
import { describe, expect, it, vi } from "vitest";
import { sendLocalImageFiles } from "./index.js";

describe("sendLocalImageFiles", () => {
  it("attaches the detail button and full HTML caption to a single image", async () => {
    const api = {
      sendPhoto: vi.fn().mockResolvedValue({ message_id: 17 }),
    } as unknown as Api;

    await expect(
      sendLocalImageFiles(api, 42, ["/tmp/one.png"], {
        prompt: "full <prompt>",
        presetKey: "wallpaper",
        detailUrl: "https://bot.example/generation/one",
        requestSnapshot: { width: 1536, height: 912 },
      }),
    ).resolves.toEqual([17]);

    expect(api.sendPhoto).toHaveBeenCalledWith(
      42,
      expect.anything(),
      expect.objectContaining({
        parse_mode: "HTML",
        caption: expect.stringContaining("full &lt;prompt&gt;"),
        reply_markup: expect.objectContaining({
          inline_keyboard: [[{ text: "查看任务详情", url: "https://bot.example/generation/one" }]],
        }),
      }),
    );
  });

  it("sends one follow-up detail button for an album", async () => {
    const api = {
      sendMediaGroup: vi.fn().mockResolvedValue([{ message_id: 20 }, { message_id: 21 }]),
      sendMessage: vi.fn().mockResolvedValue({ message_id: 22 }),
    } as unknown as Api;

    await expect(
      sendLocalImageFiles(api, -100, ["/tmp/one.png", "/tmp/two.png"], {
        prompt: "complete album prompt",
        detailUrl: "https://bot.example/generation/album",
      }),
    ).resolves.toEqual([20, 21]);

    expect(api.sendMediaGroup).toHaveBeenCalledWith(
      -100,
      expect.arrayContaining([
        expect.objectContaining({
          caption: expect.stringContaining("complete album prompt"),
          parse_mode: "HTML",
        }),
      ]),
    );
    expect(api.sendMessage).toHaveBeenCalledWith(
      -100,
      expect.stringContaining("完整 Prompt"),
      expect.objectContaining({ reply_parameters: expect.objectContaining({ message_id: 20 }) }),
    );
  });

  it("uses a custom album notice", async () => {
    const api = {
      sendMediaGroup: vi.fn().mockResolvedValue([{ message_id: 20 }, { message_id: 21 }]),
      sendMessage: vi.fn().mockResolvedValue({ message_id: 22 }),
    } as unknown as Api;

    await sendLocalImageFiles(api, -100, ["/tmp/one.png", "/tmp/two.png"], {
      prompt: "album prompt",
      detailUrl: "https://bot.example/generation/album",
      receiptConfig: { albumNoticeText: "Custom album details" },
    });

    expect(api.sendMessage).toHaveBeenCalledWith(
      -100,
      "Custom album details",
      expect.objectContaining({ reply_markup: expect.anything() }),
    );
  });

  it("does not send the album follow-up when disabled", async () => {
    const api = {
      sendMediaGroup: vi.fn().mockResolvedValue([{ message_id: 20 }, { message_id: 21 }]),
      sendMessage: vi.fn(),
    } as unknown as Api;

    await sendLocalImageFiles(api, -100, ["/tmp/one.png", "/tmp/two.png"], {
      prompt: "album prompt",
      detailUrl: "https://bot.example/generation/album",
      receiptConfig: { albumNoticeEnabled: false },
    });

    expect(api.sendMessage).not.toHaveBeenCalled();
  });

  it("links a truncated album caption when the follow-up is disabled", async () => {
    const api = {
      sendMediaGroup: vi.fn().mockResolvedValue([{ message_id: 20 }, { message_id: 21 }]),
      sendMessage: vi.fn(),
    } as unknown as Api;

    await sendLocalImageFiles(api, -100, ["/tmp/one.png", "/tmp/two.png"], {
      prompt: "long prompt ".repeat(100),
      detailUrl: "https://bot.example/generation/album?a=1&b=2",
      receiptConfig: { albumNoticeEnabled: false },
    });

    expect(api.sendMediaGroup).toHaveBeenCalledWith(
      -100,
      expect.arrayContaining([
        expect.objectContaining({
          caption: expect.stringContaining(
            '<a href="https://bot.example/generation/album?a=1&amp;b=2">',
          ),
          parse_mode: "HTML",
        }),
      ]),
    );
    expect(api.sendMessage).not.toHaveBeenCalled();
  });
});
