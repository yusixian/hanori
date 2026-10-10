import { afterEach, expect, it, vi } from "vitest";
import type { Logger } from "pino";
import { mkdir, unlink, writeFile } from "node:fs/promises";
import { cleanupGenerationImages, downloadGenerationImages } from "./generation-files.js";

vi.mock("node:fs/promises", () => ({ mkdir: vi.fn(), writeFile: vi.fn(), unlink: vi.fn() }));
vi.mock("@cos-tool-bot/shared/file-validation", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@cos-tool-bot/shared/file-validation")>()),
  getDataDir: () => "/synthetic/bot",
}));
afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

it.each([false, true])(
  "releases failed downloads and preserves successful siblings (cancel fails: %s)",
  async (cancelFails) => {
    const cancel = vi.fn(() => {
      if (cancelFails) throw new Error("cancel failed");
    });
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(new ReadableStream({ cancel }), { status: 503 }))
      .mockResolvedValueOnce(new Response(new Uint8Array([1, 2, 3])));
    vi.stubGlobal("fetch", fetchMock);
    const warn = vi.fn();
    await expect(
      downloadGenerationImages(
        "bot",
        "task",
        ["https://images.invalid/failed.png", "https://images.invalid/ok.jpg"],
        { warn } as unknown as Logger,
      ),
    ).resolves.toEqual(["task_1.jpg"]);
    expect(cancel).toHaveBeenCalledOnce();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(mkdir).toHaveBeenCalledWith("/synthetic/bot/generations", { recursive: true });
    expect(writeFile).toHaveBeenCalledExactlyOnceWith(
      "/synthetic/bot/generations/task_1.jpg",
      Buffer.from([1, 2, 3]),
    );
    expect(warn).toHaveBeenCalledExactlyOnceWith(
      { taskId: "task", index: 0, status: 503 },
      "PixAI image download failed",
    );
  },
);

it.each(["../outside", "/outside", "nested/task", "bad\0id"])(
  "does not download or write an unsafe task path: %j",
  async (taskId) => {
    const fetchMock = vi.fn(async () => new Response("image"));
    vi.stubGlobal("fetch", fetchMock);
    const warn = vi.fn();
    await expect(
      downloadGenerationImages("bot", taskId, ["https://images.invalid/image.png"], {
        warn,
      } as unknown as Logger),
    ).resolves.toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(writeFile).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledOnce();
  },
);

it("does not remove paths outside the generation directory during cleanup", async () => {
  const warn = vi.fn();
  await cleanupGenerationImages(
    "bot",
    ["../outside.png", "/outside.png", "nested/image.png", "bad\0.png", "valid_0.png"],
    { warn } as unknown as Logger,
  );
  expect(unlink).toHaveBeenCalledExactlyOnceWith("/synthetic/bot/generations/valid_0.png");
  expect(warn).toHaveBeenCalledTimes(4);
});

it.each(["任务🙂", "normal-id_1"])("preserves safe task filenames: %s", async (taskId) => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response("image")),
  );
  const warn = vi.fn();
  const filename = `${taskId}_0.webp`;
  await expect(
    downloadGenerationImages("bot", taskId, ["https://images.invalid/image.webp?size=1"], {
      warn,
    } as unknown as Logger),
  ).resolves.toEqual([filename]);
  expect(writeFile).toHaveBeenCalledExactlyOnceWith(
    `/synthetic/bot/generations/${filename}`,
    Buffer.from("image"),
  );
  await cleanupGenerationImages("bot", [filename], { warn } as unknown as Logger);
  expect(unlink).toHaveBeenCalledExactlyOnceWith(`/synthetic/bot/generations/${filename}`);
  expect(warn).not.toHaveBeenCalled();
});
