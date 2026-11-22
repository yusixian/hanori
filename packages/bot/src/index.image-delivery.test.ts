import { tmpdir } from "node:os";
import { Api, type ApiClientOptions } from "grammy";
import { autoRetry } from "@grammyjs/auto-retry";
import { realpath, mkdtemp, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { NsfwChecker } from "./services/nsfw-checker.js";
import { sendLocalImageFiles } from "./index.js";

afterEach(() => vi.restoreAllMocks());
function mockApi(methods: Record<string, (...args: any[]) => Promise<any>>): Api {
  for (const [name, mock] of Object.entries(methods))
    vi.spyOn(Api.prototype, name as "sendPhoto").mockImplementation(mock);
  return new Api("synthetic:token", { apiRoot: "http://unused.invalid" });
}

describe("sendLocalImageFiles", () => {
  it("attaches the detail button and full HTML caption to a single image", async () => {
    const api = mockApi({
      sendPhoto: vi.fn().mockResolvedValue({ message_id: 17 }),
    });

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
    const api = mockApi({
      sendMediaGroup: vi.fn().mockResolvedValue([{ message_id: 20 }, { message_id: 21 }]),
      sendMessage: vi.fn().mockResolvedValue({ message_id: 22 }),
    });

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
      {},
    );
    expect(api.sendMessage).toHaveBeenCalledWith(
      -100,
      expect.stringContaining("完整 Prompt"),
      expect.objectContaining({ reply_parameters: expect.objectContaining({ message_id: 20 }) }),
    );
  });

  it("uses a custom album notice", async () => {
    const api = mockApi({
      sendMediaGroup: vi.fn().mockResolvedValue([{ message_id: 20 }, { message_id: 21 }]),
      sendMessage: vi.fn().mockResolvedValue({ message_id: 22 }),
    });

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
    const api = mockApi({
      sendMediaGroup: vi.fn().mockResolvedValue([{ message_id: 20 }, { message_id: 21 }]),
      sendMessage: vi.fn(),
    });

    await sendLocalImageFiles(api, -100, ["/tmp/one.png", "/tmp/two.png"], {
      prompt: "album prompt",
      detailUrl: "https://bot.example/generation/album",
      receiptConfig: { albumNoticeEnabled: false },
    });

    expect(api.sendMessage).not.toHaveBeenCalled();
  });

  it("links a truncated album caption when the follow-up is disabled", async () => {
    const api = mockApi({
      sendMediaGroup: vi.fn().mockResolvedValue([{ message_id: 20 }, { message_id: 21 }]),
      sendMessage: vi.fn(),
    });

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
      {},
    );
    expect(api.sendMessage).not.toHaveBeenCalled();
  });
  it("retains image receipts when the album notice fails and sends all parts to the saved topic", async () => {
    const api = mockApi({
      sendMediaGroup: vi.fn().mockResolvedValue([{ message_id: 20 }, { message_id: 21 }]),
      sendMessage: vi.fn().mockRejectedValue(new Error("lost notice receipt")),
    });
    await expect(
      sendLocalImageFiles(api, -100, ["/tmp/one.png", "/tmp/two.png"], {
        prompt: "cat",
        detailUrl: "https://example.com/task",
        threadId: 73,
      }),
    ).resolves.toEqual([20, 21]);
    expect(api.sendMediaGroup).toHaveBeenCalledWith(-100, expect.anything(), {
      message_thread_id: 73,
    });
    expect(api.sendMessage).toHaveBeenCalledWith(
      -100,
      expect.anything(),
      expect.objectContaining({ message_thread_id: 73 }),
    );
  });
});

describe("one-shot image transport", () => {
  it("keeps topic and safety protection without inheriting autoRetry after a lost receipt", async () => {
    const directory = await mkdtemp(join(await realpath(tmpdir()), "image-delivery-"));
    const file = join(directory, "image.png");
    await writeFile(file, Buffer.from([1, 2, 3]));
    type Fetch = NonNullable<ApiClientOptions["fetch"]>;
    const fetch = vi.fn<Fetch>(async (_url: Parameters<Fetch>[0], init: Parameters<Fetch>[1]) => {
      const chunks: Buffer[] = [];
      for await (const chunk of init!.body as AsyncIterable<Uint8Array>)
        chunks.push(Buffer.from(chunk));
      const body = Buffer.concat(chunks).toString();
      expect(body).toContain("message_thread_id");
      expect(body).toContain("73");
      expect(body).toContain("has_spoiler");
      throw new Error("connection lost after upload");
    });
    const api = new Api("synthetic:token", { apiRoot: "http://unused.invalid", fetch });
    api.config.use(autoRetry({ maxRetryAttempts: 1 }));
    try {
      await expect(
        sendLocalImageFiles(api, -100, [file], {
          prompt: "cat",
          detailUrl: "https://example.com/task",
          threadId: 73,
        }),
      ).rejects.toMatchObject({ outcome: "unknown", code: "TELEGRAM_RESULT_UNKNOWN" });
      expect(fetch).toHaveBeenCalledOnce();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
  it.each([1, 2])(
    "keeps a %i-image safety preparation failure retryable until files recover",
    async (count) => {
      const directory = await mkdtemp(
        join(await realpath(tmpdir()), "image-delivery-preparation-"),
      );
      const files = Array.from({ length: count }, (_, index) => join(directory, `${index}.png`));
      const checker = new NsfwChecker({ apiUrl: "" });
      vi.spyOn(checker, "checkImageBytes").mockResolvedValue({
        status: "checked",
        isNsfw: false,
        scores: { porn: 0, sexy: 0, hentai: 0, neutral: 1, drawing: 0 },
      });
      type Fetch = NonNullable<ApiClientOptions["fetch"]>;
      const fetch = vi.fn<Fetch>(async (_url: Parameters<Fetch>[0], init: Parameters<Fetch>[1]) => {
        for await (const _chunk of init!.body as AsyncIterable<Uint8Array>) {
          /* drain upload */
        }
        return {
          json: async () => ({
            ok: true,
            result: count === 1 ? { message_id: 20 } : [{ message_id: 20 }, { message_id: 21 }],
          }),
        } as Awaited<ReturnType<Fetch>>;
      });
      const api = new Api("synthetic:token", { apiRoot: "http://unused.invalid", fetch });
      const input = {
        prompt: "cat",
        detailUrl: "https://example.com/task",
        nsfwChecker: checker,
        receiptConfig: { albumNoticeEnabled: false },
      };
      try {
        if (count === 2) await writeFile(files[0]!, Buffer.from([1, 2, 3]));
        await expect(sendLocalImageFiles(api, 42, files, input)).rejects.toMatchObject({
          outcome: "not_sent",
          code: "IMAGE_PREPARATION_FAILED",
        });
        expect(fetch).not.toHaveBeenCalled();
        for (const file of files) await writeFile(file, Buffer.from([1, 2, 3]));
        await expect(sendLocalImageFiles(api, 42, files, input)).resolves.toEqual(
          count === 1 ? [20] : [20, 21],
        );
        expect(fetch).toHaveBeenCalledOnce();
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    },
  );

  it("classifies explicit Telegram rejection as unsent", async () => {
    const fetch = vi.fn(async () => ({
      json: async () => ({
        ok: false,
        error_code: 429,
        description: "synthetic rate limit",
        parameters: { retry_after: 2 },
      }),
    }));
    const api = new Api("synthetic:token", {
      apiRoot: "http://unused.invalid",
      fetch: fetch as ApiClientOptions["fetch"],
    });
    await expect(
      sendLocalImageFiles(api, 42, [join(tmpdir(), "nonexistent-synthetic.png")], {
        prompt: "cat",
        detailUrl: "https://example.com/task",
      }),
    ).rejects.toMatchObject({ outcome: "not_sent", code: "TELEGRAM_429", retryAfterSeconds: 2 });
    expect(fetch).toHaveBeenCalledOnce();
  });
});

it("checks every album image and masks the whole batch at the configured NSFW threshold", async () => {
  const directory = await mkdtemp(join(await realpath(tmpdir()), "image-delivery-safety-"));
  const files = [join(directory, "one.png"), join(directory, "two.png")];
  await writeFile(files[0]!, Buffer.from([1, 2, 3]));
  await writeFile(files[1]!, Buffer.from([4, 5, 6]));
  const checker = new NsfwChecker({ apiUrl: "" });
  const check = vi
    .spyOn(checker, "checkImageBytes")
    .mockResolvedValueOnce({
      status: "checked",
      isNsfw: false,
      scores: { porn: 0.3, sexy: 0, hentai: 0, neutral: 0.7, drawing: 0 },
    })
    .mockResolvedValueOnce({
      status: "checked",
      isNsfw: false,
      scores: { porn: 0, sexy: 0, hentai: 0, neutral: 1, drawing: 0 },
    });
  type Fetch = NonNullable<ApiClientOptions["fetch"]>;
  const fetch = vi.fn<Fetch>(async (_url: Parameters<Fetch>[0], init: Parameters<Fetch>[1]) => {
    const chunks: Buffer[] = [];
    for await (const chunk of init!.body as AsyncIterable<Uint8Array>)
      chunks.push(Buffer.from(chunk));
    const body = Buffer.concat(chunks).toString();
    const mediaPart = body.match(/name="media"\r\n\r\n([^\r]+)/)?.[1];
    expect(mediaPart).toBeDefined();
    expect(
      JSON.parse(mediaPart!).map((media: { has_spoiler: boolean }) => media.has_spoiler),
    ).toEqual([true, true]);
    return {
      json: async () => ({ ok: true, result: [{ message_id: 20 }, { message_id: 21 }] }),
    } as Awaited<ReturnType<Fetch>>;
  });
  const api = new Api("synthetic:token", { apiRoot: "http://unused.invalid", fetch });
  api.config.use(autoRetry({ maxRetryAttempts: 1 }));
  try {
    await expect(
      sendLocalImageFiles(api, -100, files, {
        prompt: "synthetic album",
        detailUrl: "https://example.com/task",
        nsfwChecker: checker,
        nsfwThreshold: 0.2,
        receiptConfig: { albumNoticeEnabled: false },
      }),
    ).resolves.toEqual([20, 21]);
    expect(check).toHaveBeenCalledTimes(2);
    expect(check.mock.calls.map(([bytes]) => [...bytes])).toEqual([
      [1, 2, 3],
      [4, 5, 6],
    ]);
    expect(fetch).toHaveBeenCalledOnce();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
