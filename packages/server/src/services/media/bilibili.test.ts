import { beforeEach, describe, expect, it, vi } from "vitest";
import { createBilibiliClient } from "./bilibili.js";
import { MediaHttpError, readMediaDocument } from "./http.js";

vi.mock("./http.js", () => ({
  readMediaDocument: vi.fn(),
  resolveMediaUrl: vi.fn(),
  MediaHttpError: class extends Error {
    constructor(readonly code: string) {
      super(code);
    }
  },
}));

const videoData = () => ({
  aid: 42,
  bvid: "BV1z8411D7yS",
  title: "Synthetic video",
  desc: "Synthetic description",
  duration: 30,
  pubdate: 1_600_000_000,
  owner: { mid: 7, name: "Synthetic author" },
  pages: [
    { page: 1, cid: 101, part: "First part", duration: 10 },
    { page: 2, cid: 102, part: "Second part", duration: 20 },
  ],
});
const trackData = () => ({
  lan: "ai-zh",
  lan_doc: "自动字幕",
  ai_type: 0,
  subtitle_url: "//aisubtitle.hdslb.com/synthetic.json?signature=private",
});
const jsonResponse = (payload: unknown, url = "https://api.bilibili.com/synthetic") => ({
  url,
  mimeType: "application/json",
  bytes: Buffer.from(JSON.stringify(payload)),
});
function apiResult(data: unknown, code = 0) {
  vi.mocked(readMediaDocument).mockResolvedValueOnce(
    jsonResponse({ code, data, message: "private upstream text" }),
  );
}

beforeEach(() => vi.resetAllMocks());

describe("Bilibili metadata and scoped references", () => {
  it("reads only metadata and binds the selected part to its CID", async () => {
    apiResult(videoData());
    const client = createBilibiliClient({ cookie: "SESSDATA=synthetic" });
    const video = await client.getVideo("https://www.bilibili.com/video/av42?p=2");
    expect(readMediaDocument).toHaveBeenCalledTimes(1);
    expect(video).toMatchObject({
      aid: 42,
      bvid: "BV1z8411D7yS",
      selectedPart: 2,
      parts: [
        { part: 1, durationSeconds: 10 },
        { part: 2, durationSeconds: 20 },
      ],
      author: { id: 7, url: "https://space.bilibili.com/7" },
    });
    expect(readMediaDocument).toHaveBeenLastCalledWith(
      "https://api.bilibili.com/x/web-interface/view?aid=42",
      expect.objectContaining({
        credential: { origin: "https://api.bilibili.com", cookie: "SESSDATA=synthetic" },
      }),
    );
    apiResult({ aid: 42, cid: 102, need_login_subtitle: true });
    await expect(client.listSubtitles(video.reference)).resolves.toEqual({
      status: "login_required",
    });
    expect(readMediaDocument).toHaveBeenLastCalledWith(
      "https://api.bilibili.com/x/player/wbi/v2?aid=42&cid=102",
      expect.anything(),
    );
    expect(JSON.stringify(video)).not.toMatch(/SESSDATA|cid|signature/);
  });

  it.each(["av43", "BV1z8411D7yT", "https://www.bilibili.com/video/av42?p=3"])(
    "rejects mismatched identity or absent part: %s",
    async (input) => {
      apiResult(videoData());
      await expect(createBilibiliClient().getVideo(input)).rejects.toMatchObject({
        code: "invalid_response",
      });
    },
  );

  it.each([
    { pages: [] },
    { pages: [videoData().pages[0], videoData().pages[0]] },
    { pages: Array.from({ length: 1001 }, () => videoData().pages[0]) },
    { owner: { mid: 0, name: "invalid" } },
    { duration: 86_401 },
    { aid: Number.MAX_SAFE_INTEGER + 1 },
    { desc: null },
  ])("rejects malformed or oversized metadata before storing a reference", async (override) => {
    apiResult({ ...videoData(), ...override });
    await expect(createBilibiliClient().getVideo("av42")).rejects.toMatchObject({
      code: "invalid_response",
    });
  });

  it("does not accept a reference from another client or a direct subtitle URL", async () => {
    apiResult(videoData());
    const owner = createBilibiliClient();
    const stranger = createBilibiliClient();
    const video = await owner.getVideo("av42");
    await expect(stranger.listSubtitles(video.reference)).rejects.toMatchObject({
      code: "invalid_reference",
    });
    await expect(
      owner.readSubtitle("https://aisubtitle.hdslb.com/synthetic.json"),
    ).rejects.toMatchObject({ code: "invalid_reference" });
    expect(readMediaDocument).toHaveBeenCalledTimes(1);
  });

  it("caps metadata references including concurrent completions", async () => {
    vi.mocked(readMediaDocument).mockResolvedValue(jsonResponse({ code: 0, data: videoData() }));
    const client = createBilibiliClient();
    const results = await Promise.allSettled(
      Array.from({ length: 21 }, () => client.getVideo("av42")),
    );
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(20);
    expect(results.find((result) => result.status === "rejected")).toMatchObject({
      reason: { code: "reference_limit" },
    });
  });
});

describe("Bilibili subtitle availability", () => {
  it.each([
    [undefined, undefined, "authentication_unconfirmed"],
    ["SESSDATA=synthetic", true, "none"],
    ["SESSDATA=synthetic", false, "login_required"],
  ] as const)(
    "distinguishes login status before reporting empty subtitles",
    async (cookie, isLogin, status) => {
      apiResult(videoData());
      apiResult({ subtitle: { subtitles: [] } });
      if (cookie) apiResult({ isLogin }, isLogin ? 0 : -101);
      const client = createBilibiliClient({ cookie });
      const video = await client.getVideo("av42");
      await expect(client.listSubtitles(video.reference)).resolves.toEqual({ status });
      expect(readMediaDocument).toHaveBeenCalledTimes(cookie ? 3 : 2);
    },
  );

  it.each([
    {},
    { subtitle: {} },
    { subtitle: { subtitles: null } },
    { need_login_subtitle: "false", subtitle: { subtitles: [] } },
    { aid: 43, subtitle: { subtitles: [] } },
    { cid: 102, subtitle: { subtitles: [] } },
    { subtitle: { subtitles: Array.from({ length: 101 }, trackData) } },
  ])("does not treat an incomplete or mismatched list as no subtitles", async (data) => {
    apiResult(videoData());
    apiResult(data);
    const client = createBilibiliClient();
    const video = await client.getVideo("av42");
    await expect(client.listSubtitles(video.reference)).rejects.toMatchObject({
      code: "invalid_response",
    });
  });

  it("reads a registered track without sending credentials to the subtitle CDN", async () => {
    apiResult(videoData());
    apiResult({
      subtitle: { subtitles: [trackData(), { ...trackData(), lan: "en", lan_doc: "English" }] },
    });
    const client = createBilibiliClient({ cookie: "SESSDATA=synthetic" });
    const video = await client.getVideo("av42");
    const listing = await client.listSubtitles(video.reference);
    expect(listing.status).toBe("available");
    if (listing.status !== "available") throw new Error("Expected tracks");
    expect(listing.tracks.map((track) => track.source)).toEqual(["platform_auto", "platform_cc"]);
    expect(JSON.stringify(listing)).not.toMatch(/signature|hdslb|private|subtitle_url/);
    await expect(
      createBilibiliClient().readSubtitle(listing.tracks[0]!.reference),
    ).rejects.toMatchObject({ code: "invalid_reference" });
    vi.mocked(readMediaDocument).mockResolvedValueOnce(
      jsonResponse({ body: [{ from: 0, to: 1.2, content: "Synthetic text" }] }),
    );
    await expect(client.readSubtitle(listing.tracks[0]!.reference)).resolves.toEqual({
      language: "ai-zh",
      source: "platform_auto",
      track: "original",
      cues: [{ startMs: 0, endMs: 1200, text: "Synthetic text" }],
    });
    const [url, policy] = vi.mocked(readMediaDocument).mock.lastCall!;
    expect(url).toBe("https://aisubtitle.hdslb.com/synthetic.json?signature=private");
    expect(policy).not.toHaveProperty("credential");
    expect(policy.maxBytes).toBe(2 * 1024 * 1024);
  });

  it.each([
    "http://aisubtitle.hdslb.com/subtitle.json",
    "https://evil.test/subtitle.json",
    "https://aisubtitle.hdslb.com:8443/subtitle.json",
    "https://secret@aisubtitle.hdslb.com/subtitle.json",
    "https://aisubtitle.hdslb.com.evil.test/subtitle.json",
  ])("rejects an untrusted subtitle location %s before any download", async (url) => {
    apiResult(videoData());
    apiResult({ subtitle: { subtitles: [{ ...trackData(), subtitle_url: url }] } });
    const client = createBilibiliClient();
    const video = await client.getVideo("av42");
    await expect(client.listSubtitles(video.reference)).rejects.toMatchObject({
      code: "invalid_response",
    });
    expect(readMediaDocument).toHaveBeenCalledTimes(2);
  });

  it("caps registered tracks without partially storing an overflowing batch", async () => {
    apiResult(videoData());
    apiResult({ subtitle: { subtitles: Array.from({ length: 100 }, trackData) } });
    apiResult({ subtitle: { subtitles: [trackData()] } });
    const client = createBilibiliClient();
    const video = await client.getVideo("av42");
    await client.listSubtitles(video.reference);
    await expect(client.listSubtitles(video.reference)).rejects.toMatchObject({
      code: "reference_limit",
    });
  });
});

describe("Bilibili failures and cancellation", () => {
  it("does not expose platform error messages or convert them to empty results", async () => {
    apiResult(null, -352);
    await expect(createBilibiliClient().getVideo("av42")).rejects.toMatchObject({
      code: "api_rejected",
      message: "Bilibili request failed: api_rejected",
    });
    vi.mocked(readMediaDocument).mockResolvedValueOnce({
      url: "",
      mimeType: "application/json",
      bytes: Buffer.from("<html>private challenge</html>"),
    });
    await expect(createBilibiliClient().getVideo("av42")).rejects.toMatchObject({
      code: "invalid_response",
      message: "Bilibili request failed: invalid_response",
    });
    vi.mocked(readMediaDocument).mockRejectedValueOnce(new MediaHttpError("rate_limited"));
    await expect(createBilibiliClient().getVideo("av42")).rejects.toMatchObject({
      code: "rate_limited",
    });
  });

  it("honors cancellation before dispatch and after a late response", async () => {
    const controller = new AbortController();
    const reason = new Error("Synthetic cancellation");
    vi.mocked(readMediaDocument).mockImplementationOnce(async () => {
      controller.abort(reason);
      return jsonResponse({ code: 0, data: videoData() });
    });
    const client = createBilibiliClient();
    await expect(client.getVideo("av42", controller.signal)).rejects.toBe(reason);
    await expect(client.getVideo("av42", controller.signal)).rejects.toBe(reason);
    await expect(client.listSubtitles("unknown", controller.signal)).rejects.toBe(reason);
    await expect(client.readSubtitle("unknown", controller.signal)).rejects.toBe(reason);
    expect(readMediaDocument).toHaveBeenCalledTimes(1);
  });
});

describe("Bilibili host-only audio extraction", () => {
  const navigation = () => ({
    isLogin: true,
    wbi_img: {
      img_url: `https://i0.hdslb.com/bfs/wbi/${"a".repeat(32)}.png`,
      sub_url: `https://i0.hdslb.com/bfs/wbi/${"b".repeat(32)}.png`,
    },
  });
  const play = () => ({
    timelength: 20_000,
    is_preview: 0,
    dash: {
      audio: [
        {
          mimeType: "audio/mp4",
          codecs: "mp4a.40.2",
          bandwidth: 64000,
          baseUrl: "https://upos-sz-mirrorcos.bilivideo.com/synthetic.m4a?signature=private",
        },
      ],
    },
  });
  async function video(cookie: string | undefined = "SESSDATA=synthetic", downloadable = true) {
    apiResult({ ...videoData(), rights: { download: downloadable ? 1 : 0 } });
    const client = createBilibiliClient({ cookie });
    const result = await client.getVideo("https://www.bilibili.com/video/av42?p=2");
    return { client, result };
  }

  it("binds signed play info to the selected part and returns only a host-internal audio URL", async () => {
    const { client, result } = await video();
    apiResult(navigation());
    apiResult(play());
    const audio = await client.getAudio(result.reference);
    expect(audio).toMatchObject({
      allowedHosts: ["upos-sz-mirrorcos.bilivideo.com"],
      durationSeconds: 20,
    });
    const [requested, policy] = vi.mocked(readMediaDocument).mock.calls.at(-1)!;
    const url = new URL(requested);
    expect(url.pathname).toBe("/x/player/wbi/playurl");
    expect(url.searchParams.get("cid")).toBe("102");
    expect(url.searchParams.get("bvid")).toBe(result.bvid);
    expect(url.searchParams.get("w_rid")).toMatch(/^[a-f0-9]{32}$/);
    expect(policy.credential?.cookie).toBe("SESSDATA=synthetic");
    expect(JSON.stringify(result)).not.toContain("signature");
  });

  it("requires platform download permission and an authenticated session", async () => {
    const denied = await video("SESSDATA=synthetic", false);
    await expect(denied.client.getAudio(denied.result.reference)).rejects.toMatchObject({
      code: "api_rejected",
    });
    expect(readMediaDocument).toHaveBeenCalledTimes(1);
    const expired = await video();
    apiResult({ isLogin: false }, -101);
    await expect(expired.client.getAudio(expired.result.reference)).rejects.toMatchObject({
      code: "api_rejected",
    });
  });

  it.each([
    { is_preview: 1 },
    { is_drm: true },
    { drm_tech_type: 2 },
    { timelength: 5000 },
    { dash: { audio: [] } },
    { dash: { audio: [{ ...play().dash.audio[0], codecs: "drm" }] } },
    {
      dash: {
        audio: [{ ...play().dash.audio[0], baseUrl: "http://upos-sz-mirrorcos.bilivideo.com/a" }],
      },
    },
    {
      dash: {
        audio: [{ ...play().dash.audio[0], baseUrl: "https://bilivideo.com.attacker.test/a" }],
      },
    },
    { dash: { audio: [{ ...play().dash.audio[0], baseUrl: "https://127.0.0.1/a" }] } },
  ])("rejects previews, DRM and unsupported media hosts without fallback: %j", async (override) => {
    const { client, result } = await video();
    apiResult(navigation());
    apiResult({ ...play(), ...override });
    await expect(client.getAudio(result.reference)).rejects.toBeInstanceOf(Error);
    expect(readMediaDocument).toHaveBeenCalledTimes(3);
  });

  it("does not accept another session's audio reference", async () => {
    const { result } = await video();
    await expect(
      createBilibiliClient({ cookie: "other" }).getAudio(result.reference),
    ).rejects.toMatchObject({ code: "invalid_reference" });
  });
});
