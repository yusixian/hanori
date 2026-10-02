import { beforeEach, describe, expect, it, vi } from "vitest";
import { MediaHttpError, readMediaDocument } from "./http.js";
import { createNeteaseClient } from "./netease.js";

vi.mock("./http.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./http.js")>()),
  readMediaDocument: vi.fn(),
}));

const songLink = "https://music.163.com/song?id=42";
const fixtureSong = (id = 42) => ({
  id,
  name: "Synthetic track",
  artists: [{ id: 7, name: "Synthetic artist" }],
  album: { id: 8, name: "Synthetic album" },
  duration: 15_000,
  // Playback and artwork URLs are deliberately ignored, never fetched or exposed.
  mp3Url: "https://private.invalid/audio?secret=synthetic",
});

function reply(value: unknown) {
  vi.mocked(readMediaDocument).mockResolvedValueOnce({
    url: "https://music.163.com/api/ignored",
    mimeType: "application/json",
    bytes: Buffer.from(JSON.stringify(value)),
  });
}

async function getSong(client = createNeteaseClient()) {
  reply({ code: 200, songs: [fixtureSong()] });
  const result = await client.getResource(songLink);
  if (result.resourceType !== "song") throw new Error("Expected song fixture");
  return { client, result };
}

beforeEach(() => vi.resetAllMocks());

describe("NetEase read-only compatibility client", () => {
  it("returns song metadata independently of lyrics with fixed-origin bounded credentials", async () => {
    const { client, result } = await getSong(createNeteaseClient({ cookie: "MUSIC_U=synthetic" }));
    expect(result).toEqual({
      resourceType: "song",
      reference: expect.any(String),
      id: 42,
      url: songLink,
      title: "Synthetic track",
      artists: [{ id: 7, name: "Synthetic artist" }],
      album: { id: 8, title: "Synthetic album", url: "https://music.163.com/album?id=8" },
      durationMs: 15_000,
    });
    expect(readMediaDocument).toHaveBeenCalledTimes(1);
    expect(readMediaDocument).toHaveBeenCalledWith(
      "https://music.163.com/api/song/detail?id=42&ids=%5B42%5D",
      expect.objectContaining({
        allowedHosts: ["music.163.com"],
        mimeTypes: ["application/json"],
        maxBytes: 2 * 1024 * 1024,
        maxRedirects: 0,
        credential: { origin: "https://music.163.com", cookie: "MUSIC_U=synthetic" },
      }),
    );
    vi.mocked(readMediaDocument).mockRejectedValueOnce(new MediaHttpError("forbidden"));
    await expect(client.getLyrics(result.reference)).rejects.toMatchObject({ code: "forbidden" });
    expect(result.title).toBe("Synthetic track");
  });

  it("parses separate synthetic original, translation and romanization LRC tracks", async () => {
    const { client, result } = await getSong();
    reply({
      code: 200,
      lrc: { lyric: "[00:01.00]Synthetic original\n[00:03.00]Another original" },
      tlyric: { lyric: "[00:01.00]Synthetic translation" },
      romalrc: { lyric: "[00:01.00]Synthetic romanization" },
    });
    const lyrics = await client.getLyrics(result.reference);
    expect(lyrics).toMatchObject({
      status: "available",
      completeness: "upstream_unverified",
      missingTracks: [],
      tracks: [
        {
          track: "original",
          source: "lyrics",
          language: null,
          cues: [
            { startMs: 1000, endMs: 3000, text: "Synthetic original", timingInferred: true },
            { startMs: 3000, endMs: 15_000, text: "Another original", timingInferred: true },
          ],
        },
        { track: "translation" },
        { track: "romanization" },
      ],
    });
    expect(readMediaDocument).toHaveBeenLastCalledWith(
      "https://music.163.com/api/song/lyric?id=42&lv=-1&tv=-1&rv=-1",
      expect.objectContaining({ credential: undefined }),
    );
  });

  it("does not infer instrumental, authentication or completeness from an empty lyric response", async () => {
    const { client, result } = await getSong();
    reply({ code: 200, lrc: { lyric: "" } });
    await expect(client.getLyrics(result.reference)).resolves.toEqual({
      status: "unavailable",
      reason: "not_provided",
    });
    reply({ code: 200, lrc: { lyric: "[00:01.00]Synthetic original" } });
    await expect(client.getLyrics(result.reference)).resolves.toMatchObject({
      status: "available",
      missingTracks: ["translation", "romanization"],
      completeness: "upstream_unverified",
    });
  });

  it.each([
    [{ code: 200, nolyric: true }, { status: "instrumental" }],
    [{ code: 200, lrc: { lyric: "[99:00.00]纯音乐，请欣赏\n" } }, { status: "instrumental" }],
    [
      { code: 200, uncollected: true },
      { status: "unavailable", reason: "not_collected" },
    ],
  ])("reports explicit upstream lyric state %j", async (data, expected) => {
    const { client, result } = await getSong();
    reply(data);
    await expect(client.getLyrics(result.reference)).resolves.toEqual(expected);
  });

  it.each([
    { nolyric: true, lrc: { lyric: "[00:01.00]Synthetic original" } },
    { uncollected: true, tlyric: { lyric: "[00:01.00]Synthetic translation" } },
    { nolyric: "true" },
    { lrc: { lyric: "untimed text" } },
    { lrc: { lyric: "[ar:Synthetic metadata only]" } },
    { lrc: { lyric: "[00:20.00]Later than song duration" } },
    { lrc: { lyric: "[00:01.00]" + "x".repeat(4097) } },
    { lrc: { lyric: "x".repeat(500_001) } },
    { romalrc: { lyric: 42 } },
  ])("rejects malformed or contradictory lyrics without truncating them: %j", async (data) => {
    const { client, result } = await getSong();
    reply({ code: 200, ...data });
    await expect(client.getLyrics(result.reference)).rejects.toMatchObject({
      code: "invalid_response",
      message: "NetEase request failed: invalid_response",
    });
  });

  it("returns bounded legacy album tracks and their usable per-instance references", async () => {
    const client = createNeteaseClient();
    reply({
      code: 200,
      album: {
        id: 8,
        name: "Synthetic album",
        description: "Synthetic description",
        artists: [{ id: 7, name: "Synthetic artist" }],
        size: 1,
        songs: [fixtureSong()],
      },
    });
    const album = await client.getResource("https://music.163.com/album?id=8");
    expect(album).toMatchObject({
      resourceType: "album",
      tracks: {
        items: [{ reference: expect.any(String), title: "Synthetic track" }],
        total: 1,
        complete: true,
        truncated: false,
        nextOffset: null,
        upstreamPaginationAvailable: false,
      },
    });
    expect(readMediaDocument).toHaveBeenCalledWith(
      "https://music.163.com/api/album/8?id=8",
      expect.any(Object),
    );
    if (album.resourceType === "song") throw new Error("Expected album fixture");
    reply({ code: 200, nolyric: true });
    await expect(client.getLyrics(album.tracks.items[0]!.reference)).resolves.toEqual({
      status: "instrumental",
    });
  });

  it("reports both local and upstream playlist truncation without inventing pagination", async () => {
    reply({
      code: 200,
      result: {
        id: 9,
        name: "Synthetic playlist",
        trackCount: 500,
        tracks: Array.from({ length: 101 }, (_, index) => fixtureSong(index + 1)),
      },
    });
    const playlist = await createNeteaseClient().getResource("https://music.163.com/playlist?id=9");
    if (playlist.resourceType === "song") throw new Error("Expected playlist fixture");
    expect(playlist.tracks).toMatchObject({
      total: 500,
      complete: false,
      truncated: true,
      nextOffset: null,
      upstreamPaginationAvailable: false,
    });
    expect(playlist.tracks.items).toHaveLength(100);
    expect(readMediaDocument).toHaveBeenCalledTimes(1);
    expect(readMediaDocument).toHaveBeenCalledWith(
      "https://music.163.com/api/playlist/detail?id=9&lv=-1&tv=-1",
      expect.any(Object),
    );
  });

  it("does not treat an absent collection total as proof of completeness", async () => {
    reply({ code: 200, result: { id: 9, name: "Synthetic playlist", tracks: [] } });
    await expect(
      createNeteaseClient().getResource("https://music.163.com/playlist?id=9"),
    ).resolves.toMatchObject({
      tracks: { items: [], total: null, complete: false, truncated: false },
    });
  });

  it.each([
    [301, "login_required"],
    [-462, "login_required"],
    [404, "unavailable"],
    [500, "api_rejected"],
  ])("sanitizes API code %s and never carries upstream messages", async (code, expected) => {
    reply({ code, message: "https://private.invalid/?cookie=MUSIC_U=synthetic" });
    await expect(createNeteaseClient().getResource(songLink)).rejects.toMatchObject({
      code: expected,
      message: `NetEase request failed: ${expected}`,
    });
    expect(readMediaDocument).toHaveBeenCalledTimes(1);
  });

  it.each([
    { code: "200", songs: [fixtureSong()] },
    { code: 200, songs: [fixtureSong(43)] },
    { code: 200, songs: [{ ...fixtureSong(), duration: 86_400_001 }] },
    { code: 200, songs: [{ ...fixtureSong(), id: Number.MAX_SAFE_INTEGER + 1 }] },
    { code: 200, songs: [fixtureSong(), fixtureSong()] },
  ])("rejects invalid identity and bounds %j", async (data) => {
    reply(data);
    await expect(createNeteaseClient().getResource(songLink)).rejects.toMatchObject({
      code: "invalid_response",
    });
  });

  it("uses modern song aliases and bounds metadata text", async () => {
    reply({
      code: 200,
      songs: [{ id: 42, name: "x".repeat(1000), ar: [], al: { id: 8, name: "Album" }, dt: 1000 }],
    });
    await expect(createNeteaseClient().getResource(songLink)).resolves.toMatchObject({
      title: "x".repeat(300),
      durationMs: 1000,
    });
  });

  it("isolates references across clients and rejects a URL as a lyric reference before dispatch", async () => {
    const { result } = await getSong();
    await expect(createNeteaseClient().getLyrics(result.reference)).rejects.toMatchObject({
      code: "invalid_reference",
    });
    await expect(createNeteaseClient().getLyrics(songLink)).rejects.toMatchObject({
      code: "invalid_reference",
    });
    expect(readMediaDocument).toHaveBeenCalledTimes(1);
  });

  it("enforces the reference cap after concurrent I/O and never remembers partial collections", async () => {
    const client = createNeteaseClient();
    reply({
      code: 200,
      result: {
        id: 9,
        name: "Synthetic playlist",
        trackCount: 99,
        tracks: Array.from({ length: 99 }, (_, index) => fixtureSong(index + 1)),
      },
    });
    await client.getResource("https://music.163.com/playlist?id=9");
    reply({ code: 200, songs: [fixtureSong()] });
    reply({ code: 200, songs: [fixtureSong()] });
    const pending = await Promise.allSettled([
      client.getResource(songLink),
      client.getResource(songLink),
    ]);
    expect(pending.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(pending.find((result) => result.status === "rejected")).toMatchObject({
      reason: { code: "reference_limit" },
    });
    await expect(client.getResource(songLink)).rejects.toMatchObject({ code: "reference_limit" });
    expect(readMediaDocument).toHaveBeenCalledTimes(3);
  });

  it("propagates cancellation before dispatch and after a late response", async () => {
    const client = createNeteaseClient();
    const controller = new AbortController();
    const reason = new Error("Cancelled synthetic request");
    vi.mocked(readMediaDocument).mockImplementationOnce(async () => {
      controller.abort(reason);
      return {
        url: songLink,
        mimeType: "application/json",
        bytes: Buffer.from(JSON.stringify({ code: 200, songs: [fixtureSong()] })),
      };
    });
    await expect(client.getResource(songLink, controller.signal)).rejects.toBe(reason);
    await expect(client.getResource(songLink, controller.signal)).rejects.toBe(reason);
    await expect(client.getLyrics("unknown", controller.signal)).rejects.toBe(reason);
    expect(readMediaDocument).toHaveBeenCalledTimes(1);
  });

  it("fails closed on malformed JSON and unavailable song responses", async () => {
    vi.mocked(readMediaDocument).mockResolvedValueOnce({
      url: songLink,
      mimeType: "application/json",
      bytes: Buffer.from("{malformed"),
    });
    await expect(createNeteaseClient().getResource(songLink)).rejects.toMatchObject({
      code: "invalid_response",
    });
    reply({ code: 200, songs: [] });
    await expect(createNeteaseClient().getResource(songLink)).rejects.toMatchObject({
      code: "unavailable",
    });
  });
});
