import {
  parsePluginManifest,
  type PluginContext,
  type PluginSession,
  type PluginTool,
  type MediaTranscriptionPort,
  type VideoDownloadPort,
} from "@cos-tool-bot/shared";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MediaHttpError, readMediaDocument } from "../media/http.js";
import { createBuiltinMediaPlugins } from "./builtin-media.js";
import { validatePluginSession } from "./runtime.js";
import { extractWithYtdlp, YtdlpError } from "../media/yt-dlp.js";

vi.mock("../media/yt-dlp.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../media/yt-dlp.js")>()),
  extractWithYtdlp: vi.fn(),
}));

vi.mock("../media/http.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../media/http.js")>()),
  readMediaDocument: vi.fn(),
}));

const callSignal = () => new AbortController().signal;
const context = (cookie?: string): PluginContext => ({
  actor: { botId: "synthetic-bot", chatId: 1, isAdmin: false, isPrivate: true, readOnly: true },
  configuration: cookie ? { cookie } : {},
  signal: callSignal(),
});

async function session(id: string, ctx = context()): Promise<PluginSession> {
  const builtin = createBuiltinMediaPlugins().find((entry) => entry.manifest.id === id);
  if (!builtin) throw new Error("Expected builtin fixture");
  return builtin.definition.createSession(ctx);
}

function tool(session: PluginSession, name: string): PluginTool {
  const value = session.tools?.find((entry) => entry.name === name);
  if (!value) throw new Error("Expected tool fixture");
  return value;
}

async function execute(session: PluginSession, name: string, input: unknown) {
  return (await tool(session, name).execute(input, callSignal())) as Record<string, unknown>;
}

function reply(value: unknown, mimeType = "application/json") {
  vi.mocked(readMediaDocument).mockResolvedValueOnce({
    url: "https://music.163.com/ignored",
    mimeType,
    bytes: Buffer.from(JSON.stringify(value)),
  });
}

function videoReply(description = "Synthetic video description") {
  reply({
    code: 0,
    data: {
      aid: 42,
      bvid: "BV1abcdefghj",
      title: "Synthetic video",
      desc: description,
      owner: { mid: 7, name: "Synthetic creator" },
      duration: 300,
      pubdate: 1,
      pages: [{ page: 1, cid: 9, part: "Synthetic part", duration: 300 }],
    },
  });
}

function songReply() {
  reply({
    code: 200,
    songs: [
      {
        id: 42,
        name: "Synthetic song",
        artists: [{ id: 7, name: "Synthetic artist" }],
        duration: 300_000,
      },
    ],
  });
}

async function subtitleReference(session: PluginSession, language = "ai-en") {
  videoReply();
  const video = await execute(session, "lookup_video", { input: "av42" });
  reply({
    code: 0,
    data: {
      aid: 42,
      cid: 9,
      subtitle: {
        subtitles: [
          {
            lan: language,
            lan_doc: "Synthetic track",
            subtitle_url: "https://aisubtitle.hdslb.com/synthetic?token=private",
          },
        ],
      },
    },
  });
  const listing = await execute(session, "list_subtitles", {
    videoReference: video.videoReference,
  });
  return (listing.tracks as Array<{ reference: string }>)[0]!.reference;
}

function body(count: number, text = (index: number) => `Synthetic cue ${index}`) {
  return {
    body: Array.from({ length: count }, (_, index) => ({
      from: index,
      to: index + 1,
      content: text(index),
    })),
  };
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(extractWithYtdlp).mockRejectedValue(new YtdlpError("unavailable"));
});

describe("built-in media plugins", () => {
  it("publishes valid manifests, optional secret Cookies and read-only tools", async () => {
    const builtins = createBuiltinMediaPlugins();
    expect(builtins.map((entry) => entry.manifest.id)).toEqual([
      "hanori.bilibili",
      "hanori.netease",
    ]);
    for (const builtin of builtins) {
      expect(parsePluginManifest(builtin.manifest)).toMatchObject({
        apiVersion: 1,
        version: builtin.manifest.id === "hanori.bilibili" ? "1.2.0" : "1.1.0",
        login: { type: "qr" },
      });
      expect(builtin.manifest.config).toContainEqual(
        expect.objectContaining({ key: "cookie", type: "text", secret: true, required: false }),
      );
      expect(builtin.definition.check).toBeUndefined();
      expect(builtin.definition.startLogin).toBeTypeOf("function");
      const value = await builtin.definition.createSession(context());
      validatePluginSession(value);
      expect(
        value.tools?.every((tool) => tool.effect === "read_only" && tool.access === "all"),
      ).toBe(true);
      expect(
        value.searchProviders?.every(
          (provider) => provider.pagination === "single_page" && provider.allowEmptyQuery === false,
        ),
      ).toBe(true);
      await value.dispose?.();
    }
    expect(readMediaDocument).not.toHaveBeenCalled();
  });

  it.each<PluginContext["configuration"]>([
    {},
    { asrEnabled: true },
    { asrTransferApproved: true },
    { asrEnabled: true, asrTransferApproved: false },
  ])("does not inject ASR tools without both explicit approvals: %j", async (configuration) => {
    const transcription: MediaTranscriptionPort = {
      create: vi.fn(),
      get: vi.fn(),
      cancel: vi.fn(),
      read: vi.fn(),
    };
    const builtin = createBuiltinMediaPlugins({ transcription })[0]!;
    const value = await builtin.definition.createSession({
      ...context(),
      actor: { ...context().actor, userId: 42 },
      configuration,
    });
    expect(value.tools!.map(({ name }) => name)).toEqual([
      "lookup_video",
      "list_subtitles",
      "read_transcript",
    ]);
    expect(transcription.create).not.toHaveBeenCalled();
    expect(readMediaDocument).not.toHaveBeenCalled();
  });

  it("requires an injected host port and user identity even with both ASR approvals", async () => {
    const configuration = { asrEnabled: true, asrTransferApproved: true };
    const ctx = { ...context(), configuration };
    const withUser = { ...ctx, actor: { ...ctx.actor, userId: 42 } };
    const withoutPort = await createBuiltinMediaPlugins()[0]!.definition.createSession(withUser);
    expect(withoutPort.tools!.some(({ name }) => name === "transcribe_audio")).toBe(false);
    const transcription: MediaTranscriptionPort = {
      create: vi.fn(),
      get: vi.fn(),
      cancel: vi.fn(),
      read: vi.fn(),
    };
    const withoutUser = await createBuiltinMediaPlugins({
      transcription,
    })[0]!.definition.createSession(ctx);
    expect(withoutUser.tools!.some(({ name }) => name === "transcribe_audio")).toBe(false);
  });

  it("injects download tools independently of ASR only with enablement, host port and user identity", async () => {
    const downloads: VideoDownloadPort = { create: vi.fn(), get: vi.fn(), cancel: vi.fn() };
    const ctx: PluginContext = {
      ...context(),
      actor: { ...context().actor, userId: 42, isAdmin: true, readOnly: false },
      configuration: { downloadEnabled: true },
    };
    const [bilibili, netease] = createBuiltinMediaPlugins({ downloads });
    const value = await bilibili!.definition.createSession(ctx);
    validatePluginSession(value);
    expect(value.tools!.map(({ name }) => name)).toEqual([
      "download_video",
      "get_video_download",
      "cancel_video_download",
      "lookup_video",
      "list_subtitles",
      "read_transcript",
    ]);
    expect(
      value
        .tools!.filter(({ name }) => name.includes("download"))
        .every(({ access }) => access === "admin"),
    ).toBe(true);
    expect((await netease!.definition.createSession(ctx)).tools!.map(({ name }) => name)).toEqual([
      "lookup_resource",
      "read_lyrics",
    ]);
    expect(netease!.manifest.config.some(({ key }) => key.startsWith("download"))).toBe(false);
    for (const missing of [
      { ...ctx, configuration: {} },
      { ...ctx, actor: { ...ctx.actor, userId: undefined } },
    ]) {
      const disabled = await bilibili!.definition.createSession(missing);
      expect(disabled.tools!.some(({ name }) => name === "download_video")).toBe(false);
    }
    expect(
      (await createBuiltinMediaPlugins()[0]!.definition.createSession(ctx)).tools!.some(
        ({ name }) => name === "download_video",
      ),
    ).toBe(false);
    expect(downloads.create).not.toHaveBeenCalled();
    expect(readMediaDocument).not.toHaveBeenCalled();
  });

  it("injects host-bound ASR tools only for Bilibili and leaves platform subtitle tools available", async () => {
    const transcription: MediaTranscriptionPort = {
      create: vi.fn(),
      get: vi.fn(),
      cancel: vi.fn(),
      read: vi.fn(),
    };
    const configuration = {
      asrEnabled: true,
      asrTransferApproved: true,
      asrApiKey: "synthetic-asr-secret",
      cookie: "SESSDATA=synthetic-cookie",
    };
    const ctx: PluginContext = {
      ...context(),
      actor: { ...context().actor, userId: 42, isAdmin: true, readOnly: false },
      configuration,
    };
    const [bilibili, netease] = createBuiltinMediaPlugins({ transcription });
    const value = await bilibili!.definition.createSession(ctx);
    validatePluginSession(value);
    expect(value.tools!.map(({ name }) => name)).toEqual([
      "transcribe_audio",
      "get_transcription",
      "cancel_transcription",
      "read_transcription",
      "lookup_video",
      "list_subtitles",
      "read_transcript",
    ]);
    expect(tool(value, "transcribe_audio")).toMatchObject({ access: "admin", effect: "mutating" });
    expect(JSON.stringify(value.tools)).not.toContain(configuration.asrApiKey);
    expect(JSON.stringify(value.tools)).not.toContain(configuration.cookie);
    const music = await netease!.definition.createSession(ctx);
    expect(music.tools!.map(({ name }) => name)).toEqual(["lookup_resource", "read_lyrics"]);
    expect(netease!.manifest.config.some(({ key }) => key.startsWith("asr"))).toBe(false);
    expect(transcription.create).not.toHaveBeenCalled();
    expect(readMediaDocument).not.toHaveBeenCalled();
  });

  it("keeps Cookie private and sends it only to metadata API, never subtitle CDN", async () => {
    const value = await session("hanori.bilibili", context("SESSDATA=synthetic-secret"));
    const reference = await subtitleReference(value);
    reply(body(1));
    const result = await execute(value, "read_transcript", { trackReference: reference });
    expect(JSON.stringify(result)).not.toContain("synthetic-secret");
    expect(JSON.stringify(result)).not.toContain("token=private");
    expect(vi.mocked(readMediaDocument).mock.calls[0]![1].credential).toEqual({
      origin: "https://api.bilibili.com",
      cookie: "SESSDATA=synthetic-secret",
    });
    expect(vi.mocked(readMediaDocument).mock.calls[1]![1].credential).toEqual({
      origin: "https://api.bilibili.com",
      cookie: "SESSDATA=synthetic-secret",
    });
    expect(vi.mocked(readMediaDocument).mock.calls[2]![1].credential).toBeUndefined();
  });

  it("passes NetEase Cookie to its API but never returns it", async () => {
    const value = await session("hanori.netease", context("MUSIC_U=synthetic-secret"));
    songReply();
    const result = await execute(value, "lookup_resource", {
      input: "https://music.163.com/song?id=42",
    });
    expect(result).toMatchObject({ songReference: expect.any(String), title: "Synthetic song" });
    expect(JSON.stringify(result)).not.toContain("synthetic-secret");
    expect(readMediaDocument).toHaveBeenCalledWith(
      expect.stringContaining("https://music.163.com/api/song/detail"),
      expect.objectContaining({
        credential: { origin: "https://music.163.com", cookie: "MUSIC_U=synthetic-secret" },
      }),
    );
  });

  it.each(["hanori.bilibili", "hanori.netease"])(
    "unified search only looks up metadata with reusable client references: %s",
    async (id) => {
      const value = await session(id);
      const provider = value.searchProviders![0]!;
      if (id === "hanori.bilibili") videoReply();
      else songReply();
      const result = await provider.search(
        {
          scope: provider.scope,
          query: id === "hanori.bilibili" ? "av42" : "https://music.163.com/song?id=42",
          page: 1,
          limit: 10,
        },
        callSignal(),
      );
      expect(result.status).toBe("ok");
      expect(result.hasMore).toBe(false);
      expect(readMediaDocument).toHaveBeenCalledTimes(1);
      expect(result.items[0]!.content).not.toContain("cues");
      expect(result.items[0]!.content).not.toContain("token=private");
      if (id === "hanori.bilibili") {
        expect(result.items[0]!.fields?.videoReference).toEqual(expect.any(String));
        reply({ code: 0, data: { subtitle: { subtitles: [] } } });
        await expect(
          execute(value, "list_subtitles", {
            videoReference: result.items[0]!.fields!.videoReference,
          }),
        ).resolves.toMatchObject({ status: "authentication_unconfirmed" });
      } else {
        expect(result.items[0]!.fields?.songReference).toEqual(expect.any(String));
        reply({ code: 200, nolyric: true });
        await expect(
          execute(value, "read_lyrics", { songReference: result.items[0]!.fields!.songReference }),
        ).resolves.toMatchObject({ status: "instrumental" });
      }
    },
  );

  it("rejects keyword search, empty queries and page two before network work", async () => {
    const value = await session("hanori.bilibili");
    const provider = value.searchProviders![0]!;
    for (const query of ["", "synthetic keywords", "https://untrusted.invalid/video"]) {
      await expect(
        provider.search({ scope: "bilibili", query, page: 1, limit: 10 }, callSignal()),
      ).resolves.toMatchObject({ status: "invalid_request", items: [], hasMore: false });
    }
    await expect(
      provider.search({ scope: "bilibili", query: "av42", page: 2, limit: 10 }, callSignal()),
    ).resolves.toMatchObject({ status: "invalid_request" });
    expect(readMediaDocument).not.toHaveBeenCalled();
  });

  it("isolates video, track and song references across sessions", async () => {
    const firstBili = await session("hanori.bilibili");
    const secondBili = await session("hanori.bilibili");
    const track = await subtitleReference(firstBili);
    await expect(
      execute(secondBili, "read_transcript", { trackReference: track }),
    ).resolves.toMatchObject({ status: "invalid_request", error: "invalid_reference" });
    await expect(
      execute(secondBili, "list_subtitles", {
        videoReference: "https://api.bilibili.com/arbitrary",
      }),
    ).resolves.toMatchObject({ status: "invalid_request", error: "invalid_reference" });
    const firstMusic = await session("hanori.netease");
    const secondMusic = await session("hanori.netease");
    songReply();
    const music = await execute(firstMusic, "lookup_resource", {
      input: "https://music.163.com/song?id=42",
    });
    await expect(
      execute(secondMusic, "read_lyrics", { songReference: music.songReference }),
    ).resolves.toMatchObject({ status: "invalid_request", error: "invalid_reference" });
    expect(readMediaDocument).toHaveBeenCalledTimes(3);
  });

  it.each([
    { offset: -1 },
    { offset: 10_001 },
    { limit: 41 },
    { limit: 0 },
    { limit: 1.5 },
    { query: "x".repeat(201) },
    { query: " " },
    { url: "https://untrusted.invalid/subtitle" },
  ])(
    "validates transcript pagination and unknown arguments before network work %j",
    async (input) => {
      const value = await session("hanori.bilibili");
      await expect(
        execute(value, "read_transcript", { trackReference: "synthetic", ...input }),
      ).resolves.toMatchObject({ status: "invalid_request", error: "invalid_arguments" });
      expect(readMediaDocument).not.toHaveBeenCalled();
    },
  );

  it.each(["ai-en", "en"])(
    "pages and literal searches preserve platform source %s and reuse cached documents",
    async (language) => {
      const value = await session("hanori.bilibili");
      const reference = await subtitleReference(value, language);
      reply(body(50));
      const result = await execute(value, "read_transcript", {
        trackReference: reference,
        limit: 40,
      });
      expect(result).toMatchObject({
        source: language === "ai-en" ? "platform_auto" : "platform_cc",
        offset: 0,
        total: 50,
        nextOffset: 40,
        hasMore: true,
      });
      expect(result.cues).toHaveLength(40);
      const remaining = await execute(value, "read_transcript", {
        trackReference: reference,
        offset: 40,
        limit: 40,
      });
      expect(remaining).toMatchObject({ nextOffset: null, hasMore: false });
      expect(remaining.cues).toHaveLength(10);
      const matches = await execute(value, "read_transcript", {
        trackReference: reference,
        query: "CUE 4",
        limit: 2,
      });
      expect(matches).toMatchObject({
        total: 11,
        nextOffset: 2,
        hasMore: true,
        cues: [{ cueIndex: 4 }, { cueIndex: 40 }],
      });
      expect(readMediaDocument).toHaveBeenCalledTimes(3);
    },
  );

  it("enforces a 4000-character page budget without skipping a deferred cue", async () => {
    const value = await session("hanori.bilibili");
    const reference = await subtitleReference(value);
    reply(body(3, () => "x".repeat(3000)));
    const result = await execute(value, "read_transcript", {
      trackReference: reference,
      limit: 40,
    });
    expect(result).toMatchObject({ nextOffset: 1, hasMore: true, textTruncated: false });
    expect(result.cues).toHaveLength(1);
    const next = await execute(value, "read_transcript", {
      trackReference: reference,
      offset: 1,
      limit: 40,
    });
    expect(next).toMatchObject({ nextOffset: 2, cues: [{ cueIndex: 1 }] });
  });

  it("marks a clipped long cue explicitly", async () => {
    const value = await session("hanori.bilibili");
    const reference = await subtitleReference(value);
    reply(body(1, () => "x".repeat(5000)));
    const result = await execute(value, "read_transcript", { trackReference: reference });
    expect(result).toMatchObject({ textTruncated: true, cues: [{ textTruncated: true }] });
    expect((result.cues as Array<{ text: string }>)[0]!.text).toHaveLength(4000);
  });

  it("reads selected lyrics only after explicit invocation and preserves completeness", async () => {
    const value = await session("hanori.netease");
    songReply();
    const music = await execute(value, "lookup_resource", {
      input: "https://music.163.com/song?id=42",
    });
    expect(readMediaDocument).toHaveBeenCalledTimes(1);
    reply({
      code: 200,
      lrc: { lyric: "[00:01.00]Synthetic original" },
      tlyric: { lyric: "[00:01.00]Synthetic translation" },
    });
    await expect(
      execute(value, "read_lyrics", { songReference: music.songReference, track: "translation" }),
    ).resolves.toMatchObject({
      source: "lyrics",
      track: "translation",
      completeness: "upstream_unverified",
      cues: [{ text: "Synthetic translation" }],
    });
    await expect(
      execute(value, "read_lyrics", { songReference: music.songReference, track: "romanization" }),
    ).resolves.toMatchObject({ status: "unavailable", reason: "track_not_provided" });
    await expect(
      execute(value, "read_lyrics", { songReference: music.songReference, track: "unknown" }),
    ).resolves.toMatchObject({ status: "invalid_request", error: "invalid_arguments" });
    expect(readMediaDocument).toHaveBeenCalledTimes(2);
  });

  it("clears caches on disposal and prevents later client calls", async () => {
    const value = await session("hanori.bilibili");
    const reference = await subtitleReference(value);
    reply(body(1));
    await execute(value, "read_transcript", { trackReference: reference });
    await value.dispose?.();
    await expect(
      execute(value, "read_transcript", { trackReference: reference }),
    ).resolves.toMatchObject({ status: "unavailable", error: "cancelled" });
    await expect(execute(value, "lookup_video", { input: "av42" })).resolves.toMatchObject({
      status: "unavailable",
      error: "cancelled",
    });
    expect(readMediaDocument).toHaveBeenCalledTimes(3);
  });

  it("bounds the document cache at 20 entries before another subtitle fetch", async () => {
    const value = await session("hanori.bilibili");
    videoReply();
    const video = await execute(value, "lookup_video", { input: "av42" });
    const references: string[] = [];
    for (let page = 0; page < 3; page++) {
      reply({
        code: 0,
        data: {
          subtitle: {
            subtitles: Array.from({ length: 10 }, (_, index) => ({
              lan: `en-${page * 10 + index}`,
              lan_doc: "Synthetic track",
              subtitle_url: "https://aisubtitle.hdslb.com/synthetic",
            })),
          },
        },
      });
      const listing = await execute(value, "list_subtitles", {
        videoReference: video.videoReference,
      });
      references.push(
        ...(listing.tracks as Array<{ reference: string }>).map((track) => track.reference),
      );
    }
    for (const trackReference of references.slice(0, 20)) {
      reply(body(1));
      await expect(execute(value, "read_transcript", { trackReference })).resolves.toMatchObject({
        status: "available",
      });
    }
    await expect(
      execute(value, "read_transcript", { trackReference: references[20] }),
    ).resolves.toMatchObject({ status: "invalid_request", error: "reference_limit" });
    expect(readMediaDocument).toHaveBeenCalledTimes(24);
  });

  it("clips collection previews honestly while retaining usable song references", async () => {
    const value = await session("hanori.netease");
    reply({
      code: 200,
      result: {
        id: 9,
        name: "Synthetic playlist",
        description: "x".repeat(2000),
        trackCount: 15,
        tracks: Array.from({ length: 15 }, (_, index) => ({
          id: index + 1,
          name: "Synthetic track",
          duration: 1000,
        })),
      },
    });
    const playlist = await execute(value, "lookup_resource", {
      input: "https://music.163.com/playlist?id=9",
    });
    expect(playlist).toMatchObject({
      descriptionTruncated: true,
      tracks: {
        total: 15,
        complete: false,
        truncated: true,
        nextOffset: null,
        upstreamPaginationAvailable: false,
      },
    });
    const tracks = playlist.tracks as { items: Array<{ songReference: string }> };
    expect(tracks.items).toHaveLength(10);
    expect(playlist.description).toHaveLength(800);
    reply({ code: 200, nolyric: true });
    await expect(
      execute(value, "read_lyrics", { songReference: tracks.items[0]!.songReference }),
    ).resolves.toMatchObject({ status: "instrumental" });
  });

  it("never exposes raw upstream failures", async () => {
    const value = await session("hanori.netease");
    vi.mocked(readMediaDocument).mockRejectedValueOnce(
      new Error("Cookie=secret https://private.invalid/?token=secret"),
    );
    await expect(
      execute(value, "lookup_resource", { input: "https://music.163.com/song?id=42" }),
    ).resolves.toEqual({ status: "upstream_error", error: "media_failed" });
    vi.mocked(readMediaDocument).mockRejectedValueOnce(new MediaHttpError("forbidden"));
    await expect(
      execute(value, "lookup_resource", { input: "https://music.163.com/song?id=42" }),
    ).resolves.toEqual({ status: "forbidden", error: "forbidden" });
  });
});
