import { afterEach, describe, expect, it, vi } from "vitest";
import { createHarnessTelegram } from "./telegram.js";

function fakeApi() {
  return {
    token: "123:secret",
    sendMessage: vi.fn(async () => ({ message_id: 7 })),
    setMyCommands: vi.fn(async () => true),
    getFile: vi.fn(async () => ({ file_id: "f", file_path: "photos/a.jpg", file_size: 4 })),
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("createHarnessTelegram", () => {
  it("sends a force-reply prompt instead of an inline keyboard", async () => {
    const api = fakeApi();
    await createHarnessTelegram(api as never).send(-1001, {
      html: "打回原因？",
      forceReply: { placeholder: "打回原因" },
      keyboard: [[{ text: "x", callbackData: "hx:x" }]],
    });
    expect(api.sendMessage).toHaveBeenCalledWith(
      -1001,
      "打回原因？",
      expect.objectContaining({
        reply_markup: { force_reply: true, input_field_placeholder: "打回原因" },
      }),
    );
  });

  it("puts the request controls and /new in the harness chat menu", async () => {
    const api = fakeApi();
    await createHarnessTelegram(api as never).setChatCommands(-1001);
    const [commands] = api.setMyCommands.mock.calls[0] as unknown as [Array<{ command: string }>];
    expect(commands.map((c) => c.command)).toEqual([
      "status",
      "quota",
      "bug",
      "list",
      "cancel",
      "retry",
      "new",
      "harness",
      "help",
    ]);
  });

  it("downloads a file within the size limit and hides the token on failure", async () => {
    const api = fakeApi();
    const fetch = vi.fn(async () => new Response(new Uint8Array([1, 2, 3, 4])));
    vi.stubGlobal("fetch", fetch);
    const telegram = createHarnessTelegram(api as never);
    expect(await telegram.downloadFile("f", 10)).toEqual(Buffer.from([1, 2, 3, 4]));
    expect(String((fetch.mock.calls[0] as unknown[])[0])).toBe(
      "https://api.telegram.org/file/bot123:secret/photos/a.jpg",
    );
    expect(await telegram.downloadFile("f", 3)).toBeNull();

    fetch.mockRejectedValueOnce(
      new TypeError("fetch failed https://api.telegram.org/file/bot123:secret"),
    );
    await expect(telegram.downloadFile("f", 10)).rejects.toThrow("Telegram file download failed");
  });
});
