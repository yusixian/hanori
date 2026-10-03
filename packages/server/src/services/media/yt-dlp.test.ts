import { spawnSync } from "node:child_process";
import { describe, expect, it, vi } from "vitest";
import { extractWithYtdlp } from "./yt-dlp.js";

const available =
  spawnSync("python3", ["-I", "-c", "import yt_dlp"], { timeout: 5000, stdio: "ignore" }).status ===
  0;
const video = { bvid: "BV1z8411D7yS", aid: 42, cid: 102 };

// CI installs the pinned Python dependency; source-only dev environments can use the API fallback.
describe.skipIf(!available)("real yt-dlp Bilibili extractors", () => {
  it("downloads captions through the host bridge and filters danmaku", async () => {
    const read = vi.fn(async (url: string) =>
      url.includes("/x/player/")
        ? {
            code: 0,
            data: {
              subtitle: {
                subtitles: [
                  {
                    lan: "ai-zh",
                    lan_doc: "自动字幕",
                    subtitle_url: "https://aisubtitle.hdslb.com/synthetic.json",
                  },
                ],
              },
            },
          }
        : { body: [{ from: 0, to: 1, content: "中文字幕" }] },
    );
    await expect(extractWithYtdlp("subtitles", video, read)).resolves.toEqual({
      status: "ok",
      tracks: [
        {
          language: "ai-zh",
          label: "自动字幕",
          body: { body: [{ from: 0, to: 1, content: "中文字幕" }] },
        },
      ],
    });
    expect(read).toHaveBeenCalledTimes(2);
    expect(read.mock.calls[0]).toEqual([
      "https://api.bilibili.com/x/player/wbi/v2",
      { aid: 42, cid: 102 },
      expect.any(AbortSignal),
    ]);
  });

  it("uses yt-dlp WBI signing to retrieve the selected video's streams without downloading frames", async () => {
    const data = { timelength: 20_000, dash: { video: [], audio: [] } };
    const read = vi.fn(async (url: string) =>
      url.includes("/nav")
        ? {
            code: 0,
            data: {
              wbi_img: {
                img_url: `https://i0.hdslb.com/${"a".repeat(32)}.png`,
                sub_url: `https://i0.hdslb.com/${"b".repeat(32)}.png`,
              },
            },
          }
        : { code: 0, data },
    );
    await expect(extractWithYtdlp("video", video, read)).resolves.toEqual(data);
    expect(read).toHaveBeenCalledTimes(2);
    expect(read.mock.calls[1]).toEqual([
      "https://api.bilibili.com/x/player/wbi/playurl",
      expect.objectContaining({
        bvid: video.bvid,
        cid: "102",
        qn: "80",
        w_rid: expect.stringMatching(/^[a-f0-9]{32}$/),
      }),
      expect.any(AbortSignal),
    ]);
  });

  it("reports login required and preserves host failures without upstream error text", async () => {
    await expect(
      extractWithYtdlp("subtitles", video, async () => ({
        code: 0,
        data: { need_login_subtitle: true, subtitle: { subtitles: [] } },
      })),
    ).resolves.toEqual({ status: "login_required", tracks: [] });
    const failure = new Error("bounded host failure");
    await expect(
      extractWithYtdlp("subtitles", video, async () => {
        throw failure;
      }),
    ).rejects.toBe(failure);
  });

  it("cancels in-flight host reads before allowing any fallback or result", async () => {
    const controller = new AbortController();
    const read = vi.fn(async (_url: string, _query: unknown, signal: AbortSignal) => {
      controller.abort();
      expect(signal.aborted).toBe(true);
      throw signal.reason;
    });
    await expect(
      extractWithYtdlp("subtitles", video, read, controller.signal),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(read).toHaveBeenCalledOnce();
  });

  it("bounds bridge responses and terminates the extractor on oversized content", async () => {
    await expect(
      extractWithYtdlp("subtitles", video, async () => ({
        body: "x".repeat(8 * 1024 * 1024),
      })),
    ).rejects.toMatchObject({ code: "limit_exceeded" });
  });

  it("terminates the extractor and its host request at the overall deadline", async () => {
    let started!: () => void;
    const ready = new Promise<void>((resolve) => {
      started = resolve;
    });
    vi.useFakeTimers();
    try {
      const pending = extractWithYtdlp("subtitles", video, async (_url, _query, signal) => {
        started();
        return new Promise((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(signal.reason), { once: true });
        });
      });
      const assertion = expect(pending).rejects.toMatchObject({ code: "timeout" });
      await ready;
      await vi.advanceTimersByTimeAsync(30_000);
      await assertion;
    } finally {
      vi.useRealTimers();
    }
  });
});
