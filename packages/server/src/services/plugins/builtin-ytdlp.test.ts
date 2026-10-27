import { beforeEach, expect, it, vi } from "vitest";
import { createBuiltinMediaPlugins } from "./builtin-media.js";
import { bindPluginSession } from "./runtime.js";
import { runYtdlpBridge, YtdlpError } from "../media/yt-dlp.js";
import type { PluginActor, PluginContext, VideoDownloadPort } from "@cos-tool-bot/shared";

vi.mock("../media/yt-dlp.js", async (original) => ({
  ...(await original<typeof import("../media/yt-dlp.js")>()),
  runYtdlpBridge: vi.fn(),
}));
const actor: PluginActor = {
  botId: "synthetic",
  chatId: 1,
  userId: 2,
  isAdmin: true,
  isPrivate: true,
  readOnly: false,
};
const signal = new AbortController().signal;
const context = (configuration: PluginContext["configuration"] = {}): PluginContext => ({
  actor,
  signal,
  configuration,
});
const video = {
  id: "fixture",
  extractor: "Youtube",
  url: "https://www.youtube.com/watch?v=_fHTqOs5wQA",
  title: "Fixture talk",
  description: "Description only",
  author: "Fixture author",
  durationSeconds: 20,
  liveStatus: null,
  chapters: [],
  formats: [],
  tracks: [
    {
      language: "en",
      label: "English",
      source: "platform_auto",
      ext: "json3",
      url: "https://www.youtube.com/api/timedtext?signature=private",
      headers: {},
    },
  ],
};
beforeEach(() => vi.resetAllMocks());
async function setup(
  configuration: PluginContext["configuration"] = {},
  downloads?: VideoDownloadPort,
) {
  const builtin = createBuiltinMediaPlugins({ downloads }).find(
    (p) => p.manifest.id === "hanori.ytdlp",
  )!;
  const session = await builtin.definition.createSession(context(configuration));
  return {
    session,
    execute: (name: string, input: unknown) =>
      session.tools!.find((tool) => tool.name === name)!.execute(input, signal),
  };
}

it("exposes YouTube metadata, automatic captions and paged text through the registered plugin", async () => {
  vi.mocked(runYtdlpBridge)
    .mockResolvedValueOnce(video)
    .mockResolvedValueOnce({ cues: [{ startMs: 0, endMs: 1000, text: "Caption evidence" }] });
  const { execute } = await setup();
  const metadata = (await execute("lookup_video", { input: video.url })) as {
    videoReference: string;
  };
  expect(metadata).toMatchObject({ platform: "Youtube", contentSource: "metadata_only" });
  const listing = (await execute("list_subtitles", {
    videoReference: metadata.videoReference,
  })) as { tracks: Array<{ reference: string }> };
  expect(JSON.stringify(listing)).not.toContain("signature=private");
  expect(
    await execute("read_transcript", { trackReference: listing.tracks[0]!.reference }),
  ).toMatchObject({
    status: "available",
    source: "platform_auto",
    cues: [{ text: "Caption evidence" }],
    hasMore: false,
  });
  expect(await execute("lookup_video", { input: video.url, command: "unsafe" })).toEqual({
    status: "invalid_request",
    error: "invalid_arguments",
  });
});

it.each(["login_required", "rate_limited", "unsupported_url"] as const)(
  "reports %s without claiming it read the video",
  async (code) => {
    vi.mocked(runYtdlpBridge).mockRejectedValue(new YtdlpError(code));
    const { execute } = await setup();
    expect(await execute("lookup_video", { input: video.url })).toMatchObject({ error: code });
  },
);

it("binds the download provider on the host and keeps downloads admin-only", async () => {
  const port: VideoDownloadPort = { create: vi.fn(), get: vi.fn(), cancel: vi.fn() };
  const { session, execute } = await setup({ downloadEnabled: true }, port);
  await execute("download_video", { sourceUrl: video.url });
  expect(port.create).toHaveBeenCalledWith(
    expect.objectContaining({ botId: actor.botId, chatId: actor.chatId, userId: actor.userId }),
    { sourceUrl: video.url, provider: "ytdlp" },
    expect.any(AbortSignal),
  );
  const bound = bindPluginSession({
    pluginId: "hanori.ytdlp",
    session,
    actor: { ...actor, isAdmin: false },
    signal,
    authorize: async () => {},
  });
  expect(bound.tools.some((tool) => tool.name.endsWith("download_video"))).toBe(false);
  expect(
    (await setup({}, port)).session.tools!.some((tool) => tool.name === "download_video"),
  ).toBe(false);
});

it("accepts subtitle filters and exposes a primary track that can be read without listing", async () => {
  vi.mocked(runYtdlpBridge)
    .mockResolvedValueOnce({
      ...video,
      originalLanguage: "en",
      tracks: [
        {
          ...video.tracks[0],
          language: "fr",
          isTranslated: true,
          originalLanguage: "en",
          translationGroup: "en",
        },
        {
          ...video.tracks[0],
          source: "platform_cc",
          originalLanguage: "en",
          translationGroup: "en",
        },
      ],
    })
    .mockResolvedValueOnce({ cues: [{ startMs: 0, endMs: 1000, text: "Direct caption" }] });
  const { execute } = await setup();
  const found = (await execute("lookup_video", { input: video.url })) as {
    videoReference: string;
    primaryTrackReference: string;
  };
  expect(
    await execute("read_transcript", { trackReference: found.primaryTrackReference }),
  ).toMatchObject({ cues: [{ text: "Direct caption" }] });
  expect(
    await execute("list_subtitles", {
      videoReference: found.videoReference,
      language: "FR",
      source: "platform_auto",
    }),
  ).toMatchObject({ total: 1, tracks: [{ language: "fr", isTranslated: true }] });
  expect(await execute("list_subtitles", { videoReference: found.videoReference })).toMatchObject({
    total: 1,
    hiddenTranslationCount: 1,
  });
  expect(
    await execute("list_subtitles", {
      videoReference: found.videoReference,
      includeTranslations: true,
    }),
  ).toMatchObject({ total: 2 });
  for (const invalid of [
    { language: "" },
    { language: "en_*" },
    { source: "manual" },
    { includeTranslations: "true" },
    { limit: 21 },
  ]) {
    expect(
      await execute("list_subtitles", { videoReference: found.videoReference, ...invalid }),
    ).toEqual({ status: "invalid_request", error: "invalid_arguments" });
  }
  expect(runYtdlpBridge).toHaveBeenCalledTimes(2);
});

it("returns actionable recovery for stale and unknown references without calling the extractor", async () => {
  vi.mocked(runYtdlpBridge).mockResolvedValue(video);
  const first = await setup();
  const found = (await first.execute("lookup_video", { input: video.url })) as {
    videoReference: string;
    primaryTrackReference: string;
  };
  await first.session.dispose?.();
  const next = await setup();
  for (const [name, input] of [
    ["list_subtitles", { videoReference: found.videoReference }],
    ["list_formats", { videoReference: found.videoReference }],
    ["read_transcript", { trackReference: found.primaryTrackReference }],
  ] as const) {
    expect(await next.execute(name, input)).toMatchObject({
      status: "invalid_request",
      error: "reference_expired",
      recovery: expect.stringContaining("lookup_video"),
    });
  }
  expect(await next.execute("list_subtitles", { videoReference: "missing" })).toMatchObject({
    status: "invalid_request",
    error: "unknown_reference",
    recovery: expect.stringContaining("original video URL"),
  });
  expect(runYtdlpBridge).toHaveBeenCalledTimes(1);
  const refreshed = (await next.execute("lookup_video", { input: video.url })) as {
    videoReference: string;
  };
  expect(
    await next.execute("list_subtitles", { videoReference: refreshed.videoReference }),
  ).toMatchObject({ status: "available", total: 1 });
});

it("keeps malformed extractor responses separate from reference errors", async () => {
  vi.mocked(runYtdlpBridge).mockResolvedValue({ malformed: true });
  const { execute } = await setup();
  expect(await execute("lookup_video", { input: video.url })).toEqual({
    status: "upstream_error",
    error: "invalid_response",
  });
});
