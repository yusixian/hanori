import { beforeEach, expect, it, vi } from "vitest";
import { createUniversalMediaClient } from "./ytdlp-universal.js";
import { runYtdlpBridge } from "./yt-dlp.js";

vi.mock("./yt-dlp.js", async (original) => ({
  ...(await original<typeof import("./yt-dlp.js")>()),
  runYtdlpBridge: vi.fn(),
}));
const signal = () => new AbortController().signal;
const caption = (overrides = {}) => ({
  language: "en",
  label: "English",
  source: "platform_auto",
  ext: "json3",
  url: "https://www.youtube.com/api/timedtext?signature=private",
  headers: {},
  originalLanguage: "en",
  isTranslated: false,
  translationGroup: "original-en",
  ...overrides,
});
const video = (tracks = [caption()], overrides = {}) => ({
  id: "fixture",
  extractor: "Youtube",
  url: "https://www.youtube.com/watch?v=fixture",
  title: "Fixture talk",
  description: "Description only",
  author: "Fixture author",
  durationSeconds: 20,
  liveStatus: null,
  originalLanguage: "en",
  chapters: [],
  formats: [],
  tracks,
  ...overrides,
});
beforeEach(() => vi.resetAllMocks());

it("folds 176 translation languages and makes the original readable directly from lookup", async () => {
  vi.mocked(runYtdlpBridge)
    .mockResolvedValueOnce(
      video([
        ...Array.from({ length: 176 }, (_, i) =>
          caption({ language: `x-${i}`, isTranslated: true }),
        ),
        caption(),
      ]),
    )
    .mockResolvedValueOnce({ cues: [{ startMs: 0, endMs: 1000, text: "Original evidence" }] });
  const client = createUniversalMediaClient();
  const found = await client.lookup(video().url, signal());
  expect(found).toMatchObject({
    subtitleCount: 177,
    primaryTrack: { language: "en", isTranslated: false, translationCount: 176 },
  });
  expect(found.primaryTrackReference).toEqual(found.primaryTrack?.reference);
  expect(found.primaryTrackReference!.length).toBeLessThanOrEqual(100);
  expect(
    await client.transcript(found.primaryTrackReference!, { offset: 0, limit: 20 }, signal()),
  ).toMatchObject({ track: "original", cues: [{ text: "Original evidence" }] });
  expect(client.subtitles(found.videoReference, 0, 20)).toMatchObject({
    total: 1,
    nextOffset: null,
    hiddenTranslationCount: 176,
    tracks: [{ reference: found.primaryTrackReference, translationCount: 176 }],
  });
  expect(
    client.subtitles(found.videoReference, 0, 20, { includeTranslations: true }),
  ).toMatchObject({ total: 177, nextOffset: 20, hiddenTranslationCount: 0 });
  const allReferences: string[] = [];
  let offset: number | null = 0;
  while (offset !== null) {
    const page = client.subtitles(found.videoReference, offset, 20, { includeTranslations: true });
    allReferences.push(...page.tracks.map((track) => track.reference));
    offset = page.nextOffset;
  }
  expect(allReferences).toHaveLength(177);
  expect(new Set(allReferences).size).toBe(177);
  expect(JSON.stringify(found)).not.toContain("signature=private");
  expect(JSON.stringify(found)).not.toContain("original-en");
  expect(runYtdlpBridge).toHaveBeenCalledTimes(2);
});

it("filters language and source before pagination, including explicitly requested translations", async () => {
  vi.mocked(runYtdlpBridge).mockResolvedValue(
    video([
      caption({ language: "fr" }),
      caption({ language: "en-GB", source: "platform_cc", translationGroup: "gb" }),
      caption({ language: "en-US", source: "platform_cc", translationGroup: "us" }),
      caption({ language: "zh-Hans", isTranslated: true }),
      caption(),
    ]),
  );
  const client = createUniversalMediaClient();
  const found = await client.lookup(video().url, signal());
  const first = client.subtitles(found.videoReference, 0, 1, {
    language: "EN",
    source: "platform_cc",
  });
  const second = client.subtitles(found.videoReference, 1, 1, {
    language: "EN",
    source: "platform_cc",
  });
  expect(first).toMatchObject({ total: 2, nextOffset: 1, tracks: [{ language: "en-GB" }] });
  expect(second).toMatchObject({ total: 2, nextOffset: null, tracks: [{ language: "en-US" }] });
  expect(first.tracks[0]!.reference).not.toBe(second.tracks[0]!.reference);
  expect(
    client.subtitles(found.videoReference, 0, 20, { language: "zh", source: "platform_auto" }),
  ).toMatchObject({ total: 1, tracks: [{ language: "zh-Hans", isTranslated: true }] });
  expect(client.subtitles(found.videoReference, 0, 20, { language: "ja" })).toMatchObject({
    total: 0,
    reason: "no_matching_subtitles",
    nextOffset: null,
  });
  expect(
    client.subtitles(found.videoReference, 2, 1, { language: "en", source: "platform_cc" }).tracks,
  ).toEqual([]);
});

it("lists platform CC first but recommends the original language before unrelated CC", async () => {
  vi.mocked(runYtdlpBridge).mockResolvedValue(
    video([caption(), caption({ language: "fr", source: "platform_cc", translationGroup: "fr" })]),
  );
  const client = createUniversalMediaClient();
  const found = await client.lookup(video().url, signal());
  expect(client.subtitles(found.videoReference, 0, 20).tracks.map((t) => t.source)).toEqual([
    "platform_cc",
    "platform_auto",
  ]);
  expect(found.primaryTrack).toMatchObject({ language: "en", source: "platform_auto" });
});

it("prefers CC in the original language and preserves unclassified automatic tracks", async () => {
  vi.mocked(runYtdlpBridge).mockResolvedValue(
    video([
      caption({ translationGroup: null }),
      caption({ source: "platform_cc", translationGroup: null }),
      caption({ language: "de", translationGroup: null }),
    ]),
  );
  const client = createUniversalMediaClient();
  const found = await client.lookup(video().url, signal());
  expect(found.primaryTrack).toMatchObject({ language: "en", source: "platform_cc" });
  expect(client.subtitles(found.videoReference, 0, 20)).toMatchObject({
    total: 3,
    hiddenTranslationCount: 0,
  });
});

it("keeps translation-only groups discoverable and marks their transcript as translated", async () => {
  vi.mocked(runYtdlpBridge)
    .mockResolvedValueOnce(
      video([
        caption({ language: "de", isTranslated: true }),
        caption({ language: "fr", isTranslated: true }),
      ]),
    )
    .mockResolvedValueOnce({ cues: [{ startMs: 0, endMs: 1000, text: "Translated evidence" }] });
  const client = createUniversalMediaClient();
  const found = await client.lookup(video().url, signal());
  const listing = client.subtitles(found.videoReference, 0, 10);
  expect(listing).toMatchObject({
    total: 1,
    hiddenTranslationCount: 1,
    tracks: [{ isTranslated: true, translationCount: 2 }],
  });
  expect(
    await client.transcript(listing.tracks[0]!.reference, { offset: 0, limit: 10 }, signal()),
  ).toMatchObject({ track: "translation" });
});

it("reports unavailable captions without inventing a primary reference", async () => {
  vi.mocked(runYtdlpBridge).mockResolvedValue(video([]));
  const client = createUniversalMediaClient();
  const found = await client.lookup(video().url, signal());
  expect(found.primaryTrackReference).toBeNull();
  expect(found.primaryTrack).toBeNull();
  expect(client.subtitles(found.videoReference, 0, 20)).toMatchObject({
    status: "unavailable",
    reason: "no_subtitles_reported",
  });
});

it("distinguishes unknown references from references cleared or used in a new client", async () => {
  vi.mocked(runYtdlpBridge).mockResolvedValue(video());
  const client = createUniversalMediaClient();
  const found = await client.lookup(video().url, signal());
  const next = createUniversalMediaClient();
  expect(() => client.subtitles("missing", 0, 20)).toThrowError(
    expect.objectContaining({ code: "unknown_reference" }),
  );
  expect(() => client.formats(found.primaryTrackReference!, 0, 20)).toThrowError(
    expect.objectContaining({ code: "unknown_reference" }),
  );
  expect(() => next.subtitles(found.videoReference, 0, 20)).toThrowError(
    expect.objectContaining({ code: "reference_expired" }),
  );
  await expect(
    next.transcript(found.primaryTrackReference!, { offset: 0, limit: 20 }, signal()),
  ).rejects.toMatchObject({ code: "reference_expired" });
  client.clear();
  expect(() => client.formats(found.videoReference, 0, 20)).toThrowError(
    expect.objectContaining({ code: "reference_expired" }),
  );
  const refreshed = await client.lookup(video().url, signal());
  expect(refreshed.videoReference).not.toBe(found.videoReference);
  expect(client.subtitles(refreshed.videoReference, 0, 20).total).toBe(1);
});

it("does not resurrect an in-flight lookup after clearing its scope", async () => {
  let complete!: (value: unknown) => void;
  vi.mocked(runYtdlpBridge).mockReturnValue(
    new Promise((resolve) => {
      complete = resolve;
    }),
  );
  const client = createUniversalMediaClient();
  const pending = client.lookup(video().url, signal());
  const rejected = expect(pending).rejects.toMatchObject({ code: "reference_expired" });
  client.clear();
  complete(video());
  await rejected;
});

it("rejects an in-flight transcript after its references expire", async () => {
  vi.mocked(runYtdlpBridge).mockResolvedValueOnce(video());
  const client = createUniversalMediaClient();
  const found = await client.lookup(video().url, signal());
  let complete!: (value: unknown) => void;
  vi.mocked(runYtdlpBridge).mockReturnValueOnce(
    new Promise((resolve) => {
      complete = resolve;
    }),
  );
  const pending = client.transcript(
    found.primaryTrackReference!,
    { offset: 0, limit: 20 },
    signal(),
  );
  const rejected = expect(pending).rejects.toMatchObject({ code: "reference_expired" });
  client.clear();
  complete({ cues: [{ startMs: 0, endMs: 1000, text: "Late caption" }] });
  await rejected;
});
