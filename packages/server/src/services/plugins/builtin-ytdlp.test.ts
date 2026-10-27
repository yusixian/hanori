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
