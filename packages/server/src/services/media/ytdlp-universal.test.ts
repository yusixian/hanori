import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createUniversalMediaClient,
  inspectWithYtdlp,
  downloadWithYtdlp,
} from "./ytdlp-universal.js";
import { readExtractorResponse } from "./http.js";
import { runYtdlpBridge } from "./yt-dlp.js";
import { UNIVERSAL_YTDLP_SCRIPT } from "./ytdlp-universal-script.js";

vi.mock("./http.js", async (original) => ({
  ...(await original<typeof import("./http.js")>()),
  readExtractorResponse: vi.fn(),
}));
const available =
  spawnSync("python3", ["-I", "-c", "import yt_dlp"], { timeout: 5000, stdio: "ignore" }).status ===
  0;
const signal = () => new AbortController().signal;
const reply = (url: string, text: string, mime = "text/html", status = 200, headers = {}) => ({
  url,
  status,
  headers: { "content-type": mime, ...headers },
  data: Buffer.from(text).toString("base64"),
});
afterEach(() => vi.resetAllMocks());

describe.skipIf(!available)("universal real yt-dlp extraction", { timeout: 20_000 }, () => {
  it("normalizes YouTube originals, aliases and translated tracks using actual bridge metadata", async () => {
    const base =
      "https://www.youtube.com/api/timedtext?v=fixture&lang=en&kind=asr&signature=private";
    const formats = (url: string) => [{ url, ext: "json3", name: "Fixture caption" }];
    const automatic = Object.fromEntries([
      ...Array.from({ length: 176 }, (_, index) => [
        `x-${index}`,
        formats(`${base}&tlang=x-${index}&fmt=json3`),
      ]),
      ["en-orig", formats(`${base}&fmt=json3`)],
      ["en", formats(`${base}&fmt=json3`)],
    ]);
    const fixture = {
      id: "fixture",
      extractor_key: "Youtube",
      webpage_url: "https://www.youtube.com/watch?v=fixture",
      automatic_captions: automatic,
    };
    // Execute the production normalization functions with extractor output, without live requests.
    const definitions = UNIVERSAL_YTDLP_SCRIPT.split("\ntry:\n    options =")[0]!;
    const normalize = (info: unknown) =>
      runYtdlpBridge({
        script: `${definitions}\nemit({"type":"result","value":summary(request["fixture"])})`,
        input: { fixture: info, nodePath: process.execPath },
        read: vi.fn(),
      }) as Promise<import("./ytdlp-universal.js").ExtractedVideo>;
    const value = await normalize(fixture);
    expect(value.originalLanguage).toBe("en");
    expect(value.tracks).toHaveLength(177);
    expect(value.tracks[0]).toMatchObject({
      language: "en",
      isTranslated: false,
      originalLanguage: "en",
    });
    expect(value.tracks.slice(1).every((t) => t.isTranslated)).toBe(true);
    expect(new Set(value.tracks.map((t) => t.translationGroup)).size).toBe(1);

    const manual = "https://www.youtube.com/api/timedtext?v=fixture&lang=en&signature=private";
    const cc = await normalize({
      ...fixture,
      formats: [{ acodec: "aac", language: "en", language_preference: 10 }],
      subtitles: { en: formats(`${manual}&fmt=vtt`) },
      automatic_captions: {
        "en-en": formats(`${manual}&fmt=json3`),
        "zh-Hans-en": formats(`${manual}&tlang=zh-Hans&fmt=json3`),
      },
    });
    expect(cc.originalLanguage).toBe("en");
    expect(cc.tracks).toHaveLength(2);
    expect(cc.tracks[0]).toMatchObject({
      language: "en",
      source: "platform_cc",
      isTranslated: false,
    });
    expect(cc.tracks[1]).toMatchObject({
      language: "zh-Hans",
      source: "platform_auto",
      isTranslated: true,
    });
    expect(cc.tracks[0]!.translationGroup).toBe(cc.tracks[1]!.translationGroup);

    const generic = await normalize({
      ...fixture,
      extractor_key: "Generic",
      automatic_captions: { en: formats(`${base}&tlang=fr`) },
    });
    expect(generic.tracks).toMatchObject([
      { language: "en", isTranslated: false, translationGroup: null },
    ]);
    expect(generic.originalLanguage).toBeNull();
  });

  it("uses the upstream generic extractor for an unlisted site's direct media", async () => {
    vi.mocked(readExtractorResponse).mockImplementation(async (url) =>
      reply(url, "synthetic-video", "video/mp4"),
    );
    const video = await inspectWithYtdlp("https://media.example/demo.mp4", undefined, signal());
    expect(video).toMatchObject({ id: "demo", extractor: "Generic", title: "demo", tracks: [] });
    expect(video.formats.length).toBeGreaterThan(0);
    expect(readExtractorResponse).toHaveBeenCalled();
  });

  it("reads HTML5 video captions, keeps signed URLs private and caches metadata and transcripts", async () => {
    vi.mocked(readExtractorResponse).mockImplementation(async (url) =>
      url.includes("captions")
        ? reply(
            url,
            "WEBVTT\n\n00:00:00.000 --> 00:00:02.000\nHello &amp; welcome\n\n00:00:02.000 --> 00:00:03.000\nSecond cue\n",
            "text/vtt",
          )
        : reply(
            url,
            '<html><head><title>Example talk</title></head><body><video controls><source src="https://cdn.example/clip.mp4" type="video/mp4"><track src="https://cdn.example/captions.vtt?signature=private" kind="subtitles" srclang="en_US" label="English"></video></body></html>',
          ),
    );
    const client = createUniversalMediaClient();
    const video = await client.lookup("https://media.example/talk", signal());
    expect(video.subtitleCount).toBe(1);
    expect(JSON.stringify(video)).not.toContain("signature=private");
    expect(await client.lookup("https://media.example/talk", signal())).toEqual(video);
    const listing = client.subtitles(video.videoReference, 0, 10);
    const track = listing.tracks[0]!;
    expect(track.language).toBe("en-US");
    expect(JSON.stringify(listing)).not.toContain("signature=private");
    const first = await client.transcript(track.reference, { offset: 0, limit: 1 }, signal());
    expect(first).toMatchObject({
      source: "platform_cc",
      cues: [{ startMs: 0, endMs: 2000, text: "Hello & welcome" }],
      nextOffset: 1,
    });
    const count = vi.mocked(readExtractorResponse).mock.calls.length;
    expect(
      await client.transcript(track.reference, { offset: 1, limit: 1 }, signal()),
    ).toMatchObject({ cues: [{ text: "Second cue" }], nextOffset: null });
    expect(vi.mocked(readExtractorResponse).mock.calls.length).toBe(count);
    client.clear();
    expect(() => client.subtitles(video.videoReference, 0, 10)).toThrow();
  });

  it("keeps configured cookies domain scoped across redirects and removes site headers", async () => {
    const cookies =
      "# Netscape HTTP Cookie File\n.media.example\tTRUE\t/\tTRUE\t0\tsession\tprivate-value\n";
    const read = vi.fn(async (url: string, request: Record<string, unknown>) => {
      if (url.includes("media.example"))
        return {
          ...reply(url, "", "text/plain", 302),
          headers: { location: "https://cdn.example/captions.vtt" },
        };
      expect(JSON.stringify(request)).not.toContain("private-value");
      expect(request.headers).not.toHaveProperty("X-Site-Token");
      return reply(url, "WEBVTT\n\n00:00:00.000 --> 00:00:01.000\nCaption\n", "text/vtt");
    });
    const value = await runYtdlpBridge({
      script: UNIVERSAL_YTDLP_SCRIPT,
      input: {
        operation: "subtitle",
        url: "https://media.example/captions",
        ext: "vtt",
        cookies,
        headers: { "X-Site-Token": "private-token" },
        nodePath: process.execPath,
      },
      read,
    });
    expect(value).toMatchObject({ cues: [{ text: "Caption" }] });
    expect(read.mock.calls[0]![1].headers).toMatchObject({ Cookie: "session=private-value" });
  });

  it.each([
    [
      "json3",
      JSON.stringify({
        events: [
          { tStartMs: 0, dDurationMs: 1200, segs: [{ utf8: "Automatic " }, { utf8: "caption" }] },
        ],
      }),
      "Automatic caption",
    ],
    ["srt", "1\n00:00:00,000 --> 00:00:01,200\nCaption\n", "Caption"],
    [
      "ttml",
      '<tt xmlns="http://www.w3.org/ns/ttml"><body><p begin="0s" end="1.2s">Caption</p></body></tt>',
      "Caption",
    ],
    ["srv3", '<timedtext><body><p t="0" d="1200"><s>Caption</s></p></body></timedtext>', "Caption"],
    ["json", JSON.stringify({ body: [{ from: 0, to: 1.2, content: "Caption" }] }), "Caption"],
  ])("parses %s into bounded timestamped cues", async (ext, text, expected) => {
    const read = vi.fn();
    await expect(
      runYtdlpBridge({
        script: UNIVERSAL_YTDLP_SCRIPT,
        input: { operation: "subtitle", text, ext, nodePath: process.execPath },
        read,
      }),
    ).resolves.toEqual({ cues: [{ startMs: 0, endMs: 1200, text: expected }] });
    expect(read).not.toHaveBeenCalled();
  });

  it("rejects XML entities and unsupported source protocols without network activity", async () => {
    await expect(
      runYtdlpBridge({
        script: UNIVERSAL_YTDLP_SCRIPT,
        input: {
          operation: "subtitle",
          text: '<!DOCTYPE tt [<!ENTITY file SYSTEM "file:///etc/passwd">]><tt/>',
          ext: "ttml",
          nodePath: process.execPath,
        },
        read: vi.fn(),
      }),
    ).rejects.toMatchObject({ code: "extractor_failed" });
    await expect(inspectWithYtdlp("file:///etc/passwd", undefined, signal())).rejects.toMatchObject(
      { code: "invalid_request" },
    );
    expect(readExtractorResponse).not.toHaveBeenCalled();
  });

  it("downloads native HTTP media into host-owned paths without running ffmpeg", async () => {
    const directory = await mkdtemp(join(tmpdir(), "universal-download-"));
    try {
      const html =
        '<html><head><title>Example talk</title><script type="application/ld+json">{"@context":"https://schema.org","@type":"VideoObject","name":"Example talk","description":"Fixture","duration":"PT1S","contentUrl":"https://cdn.example/clip.mp4"}</script></head><body><video src="https://cdn.example/clip.mp4" controls></video></body></html>';
      vi.mocked(readExtractorResponse).mockImplementation(async (url) =>
        url.includes("cdn.example")
          ? reply(url, "synthetic-video", "video/mp4", 200, { "content-length": "15" })
          : reply(url, html),
      );
      const video = await inspectWithYtdlp("https://media.example/talk", undefined, signal());
      expect(video.durationSeconds).toBeNull();
      await expect(
        downloadWithYtdlp(
          {
            url: video.url,
            expectedId: video.id,
            expectedExtractor: video.extractor,
            directory,
            maxBytes: 1000,
            maxSeconds: 5,
          },
          undefined,
          signal(),
        ),
      ).resolves.toMatchObject({ bytes: 15, separateAudio: false });
      expect(await readFile(join(directory, "video.mp4"), "utf8")).toBe("synthetic-video");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it.each([
    [
      "hls.m3u8",
      "application/vnd.apple.mpegurl",
      "#EXTM3U\n#EXT-X-TARGETDURATION:1\n#EXT-X-MEDIA-SEQUENCE:0\n#EXTINF:1,\nsegment.ts\n#EXT-X-ENDLIST\n",
      "synthetic-segment",
    ],
    [
      "dash.mpd",
      "application/dash+xml",
      '<MPD xmlns="urn:mpeg:dash:schema:mpd:2011" type="static" mediaPresentationDuration="PT1S"><Period><AdaptationSet mimeType="video/mp4" contentType="video"><Representation id="video" bandwidth="1000" codecs="avc1.42c01e" width="320" height="180"><SegmentList duration="1"><Initialization sourceURL="init.mp4"/><SegmentURL media="segment.m4s"/></SegmentList></Representation></AdaptationSet></Period></MPD>',
      "synthetic-initsynthetic-segment",
    ],
  ])(
    "downloads native %s manifests and segments through the host",
    async (file, mime, manifest, expected) => {
      const directory = await mkdtemp(join(tmpdir(), "universal-segments-"));
      try {
        vi.mocked(readExtractorResponse).mockImplementation(async (url) => {
          if (url.endsWith(file)) return reply(url, manifest, mime);
          const content = url.endsWith("init.mp4") ? "synthetic-init" : "synthetic-segment";
          return reply(url, content, "video/mp4", 200, {
            "content-length": String(content.length),
          });
        });
        const video = await inspectWithYtdlp(`https://media.example/${file}`, undefined, signal());
        await expect(
          downloadWithYtdlp(
            {
              url: video.url,
              expectedId: video.id,
              expectedExtractor: video.extractor,
              directory,
              maxBytes: 1000,
              maxSeconds: 5,
            },
            undefined,
            signal(),
          ),
        ).resolves.toMatchObject({ bytes: expected.length, separateAudio: false });
        expect(await readFile(join(directory, "video.mp4"), "utf8")).toBe(expected);
        expect(
          vi.mocked(readExtractorResponse).mock.calls.some(([url]) => url.includes("segment.")),
        ).toBe(true);
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    },
  );
});
