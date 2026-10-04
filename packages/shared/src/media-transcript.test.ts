import { describe, expect, it } from "vitest";
import {
  findTranscript,
  pageTranscript,
  parseBilibiliSubtitle,
  parseLrc,
  serializeSrt,
  serializeVtt,
  TranscriptError,
  TRANSCRIPT_BOUNDS,
  ASR_TRANSCRIPT_BOUNDS,
  type TranscriptDocument,
} from "./media-transcript.js";

function subtitle(): TranscriptDocument {
  return parseBilibiliSubtitle(
    {
      body: [
        { from: 1.125, to: 2.5, content: "Synthetic first" },
        { from: 3, to: 4.001, content: "Synthetic SECOND" },
        { from: 5, to: 6, content: "Other text" },
      ],
    },
    { source: "author", language: "en" },
  );
}

describe("LRC transcript", () => {
  it("expands repeated timestamps, sorts stably, keeps milliseconds and ignores metadata", () => {
    const document = parseLrc(
      "\uFEFF[ti:Synthetic]\r\n[ar:Test]\r[00:03.125][00:01.25]Repeated\n[00:01.250]Same start\n[00:04]Last",
      { language: "zh-CN", track: "translation" },
    );
    expect(document).toEqual({
      language: "zh-CN",
      source: "lyrics",
      track: "translation",
      cues: [
        { startMs: 1250, endMs: 3125, text: "Repeated", timingInferred: true },
        { startMs: 1250, endMs: 3125, text: "Same start", timingInferred: true },
        { startMs: 3125, endMs: 4000, text: "Repeated", timingInferred: true },
        { startMs: 4000, endMs: null, text: "Last", timingInferred: true },
      ],
    });
    expect(document.cues.every((cue) => cue.uncertain === undefined)).toBe(true);
  });

  it("scales fractions as decimal seconds including the compatible colon separator", () => {
    const document = parseLrc("[00:01.1]One\n[00:02.01]Two\n[00:03:001]Three\n[60:00]Hour");
    expect(document.cues.map((cue) => cue.startMs)).toEqual([1100, 2010, 3001, 3_600_000]);
  });

  it("applies the final global offset to every cue and uses an explicit duration", () => {
    const earlier = parseLrc("[00:01]One\n[00:03]Two\n[offset:+250]", { durationMs: 4500 });
    expect(earlier.cues.map(({ startMs, endMs }) => ({ startMs, endMs }))).toEqual([
      { startMs: 750, endMs: 2750 },
      { startMs: 2750, endMs: 4500 },
    ]);
    const later = parseLrc("[offset:-500]\n[00:01]One");
    expect(later.cues[0]?.startMs).toBe(1500);
  });

  it("keeps blank timed boundaries and never derives instrumental status from words", () => {
    const document = parseLrc("[au:instrumental]\n[00:01]纯音乐\n[00:02]\n[00:03]Instrumental", {
      track: "romanization",
    });
    expect(document.cues.map((cue) => cue.text)).toEqual(["纯音乐", "", "Instrumental"]);
    expect(document.cues[0]?.endMs).toBe(2000);
    expect(document).not.toHaveProperty("instrumental");
    expect(parseLrc("[ti:Metadata only]").cues).toEqual([]);
    expect(parseLrc("").cues).toEqual([]);
  });

  it.each([
    "[00:60]Synthetic",
    "[-01:00]Synthetic",
    "[00:01.1234]Synthetic",
    "[00:1.1x]Synthetic",
    "[00:01Synthetic",
    "Untimed plain text",
    "[offset:NaN]\n[00:01]Synthetic",
    "[offset:2000]\n[00:01]Synthetic",
    "[offset:86400001]\n[00:01]Synthetic",
    "[1441:00]Synthetic",
  ])("rejects malformed/out-of-range timestamps without echoing input: %s", (input) => {
    expect(() => parseLrc(input)).toThrow(TranscriptError);
  });

  it("rejects a duration that cannot close the last timestamp", () => {
    expect(() => parseLrc("[00:02]Synthetic", { durationMs: 2000 })).toThrow("interval");
    expect(() => parseLrc("[00:02]Synthetic", { durationMs: Number.NaN })).toThrow("timestamp");
  });
});

describe("Bilibili subtitle subset", () => {
  it("normalizes seconds and sorted cues without retaining executable or provenance fields", () => {
    const document = parseBilibiliSubtitle(
      {
        body: [
          {
            from: 2.1236,
            to: 3.1111,
            content: "<script>synthetic()</script>",
            source: "author",
            uncertain: true,
          },
          { from: 0, to: 1, content: "Early" },
        ],
        script: "ignored",
      },
      { source: "platform_auto" },
    );
    expect(document).toEqual({
      language: null,
      source: "platform_auto",
      track: "original",
      cues: [
        { startMs: 0, endMs: 1000, text: "Early" },
        { startMs: 2124, endMs: 3111, text: "<script>synthetic()</script>" },
      ],
    });
  });

  it.each([
    null,
    [],
    { body: null },
    { body: [{}] },
    { body: [{ from: "1", to: 2, content: "Synthetic" }] },
    { body: [{ from: -0.00001, to: 1, content: "Synthetic" }] },
    { body: [{ from: 0, to: Infinity, content: "Synthetic" }] },
    { body: [{ from: Number.NaN, to: 2, content: "Synthetic" }] },
    { body: [{ from: 1, to: 0, content: "Synthetic" }] },
    { body: [{ from: 1, to: 1, content: "Synthetic" }] },
    { body: [{ from: 1.00001, to: 1.00002, content: "Synthetic" }] },
    { body: [{ from: 0, to: 86401, content: "Synthetic" }] },
    { body: [{ from: 0, to: 1, content: { html: "Synthetic" } }] },
  ])("rejects malformed JSON input and invalid intervals", (input) => {
    expect(() => parseBilibiliSubtitle(input, { source: "author" })).toThrow(TranscriptError);
  });

  it("requires the host to choose valid platform provenance independently of the words", () => {
    expect(parseBilibiliSubtitle({ body: [] }, { source: "platform_cc" }).source).toBe(
      "platform_cc",
    );
    expect(() => parseBilibiliSubtitle({ body: [] }, { source: "asr" } as never)).toThrow("source");
    expect(() => parseBilibiliSubtitle({ body: [] }, { source: undefined } as never)).toThrow(
      "source",
    );
  });
});

describe("bounded input", () => {
  it("pages and searches long ASR results past 10,000 cues while preserving platform limits", () => {
    const document: TranscriptDocument = {
      language: "en",
      source: "asr",
      track: "original",
      cues: Array.from({ length: 10_002 }, (_, i) => ({
        startMs: i * 1000,
        endMs: i * 1000 + 900,
        text: "Synthetic transcript ".repeat(3),
      })),
    };
    expect(pageTranscript(document, { offset: 10_000, limit: 2 })).toMatchObject({
      total: 10_002,
      nextOffset: null,
    });
    expect(findTranscript(document, "Synthetic", { offset: 10_001 })).toMatchObject({
      total: 10_002,
      items: [{ cueIndex: 10_001 }],
    });
    expect(serializeSrt(document)).toContain("02:46:41,000");
    expect(() => pageTranscript({ ...document, source: "platform_auto" })).toThrow("cue limit");
    expect(() => pageTranscript(document, { offset: ASR_TRANSCRIPT_BOUNDS.maxCues + 1 })).toThrow(
      "page",
    );
    expect(() =>
      pageTranscript({
        ...document,
        cues: Array.from({ length: ASR_TRANSCRIPT_BOUNDS.maxCues + 1 }, () => document.cues[0]!),
      }),
    ).toThrow("cue limit");
  });
  it("enforces raw length, expanded cue count and repeated text totals", () => {
    expect(() =>
      parseLrc("[ti:" + "x".repeat(20) + "]", { bounds: { maxInputChars: 10 } }),
    ).toThrow("input limit");
    expect(() => parseLrc("[00:01][00:02]Synthetic", { bounds: { maxCues: 1 } })).toThrow(
      "cue limit",
    );
    expect(() => parseLrc("[00:01][00:02]Synthetic", { bounds: { maxTextChars: 10 } })).toThrow(
      "text limit",
    );
    expect(() => parseLrc("[00:01]Synthetic", { bounds: { maxCueChars: 5 } })).toThrow(
      "cue text limit",
    );
    expect(() => parseLrc("[00:01]Synthetic", { bounds: { maxTimeMs: 500 } })).toThrow("timestamp");
    expect(() =>
      parseBilibiliSubtitle(
        { body: [{ from: 0, to: 1, content: "x".repeat(20) }] },
        { source: "author", bounds: { maxInputChars: 10 } },
      ),
    ).toThrow("text limit");
    expect(() =>
      parseBilibiliSubtitle(
        { body: Array.from({ length: TRANSCRIPT_BOUNDS.maxCues + 1 }, () => null) },
        { source: "author" },
      ),
    ).toThrow("body");
  });

  it.each([Infinity, Number.NaN, 0, -1, 1.5, TRANSCRIPT_BOUNDS.maxCues + 1])(
    "rejects raised or invalid limits %s",
    (maxCues) => {
      expect(() => parseLrc("", { bounds: { maxCues } })).toThrow("limit");
    },
  );

  it("validates metadata and bounds even for empty documents", () => {
    expect(() => parseLrc("", { language: "en<script>" })).toThrow("language");
    expect(() => parseLrc("", { track: "unknown" } as never)).toThrow("track");
    expect(() => parseLrc("", { durationMs: TRANSCRIPT_BOUNDS.maxTimeMs + 1 })).toThrow(
      "timestamp",
    );
  });
});

describe("pagination and literal keyword locations", () => {
  it("returns stable offsets, preserves timestamps and does not mutate the document", () => {
    const document = subtitle();
    const before = structuredClone(document);
    expect(pageTranscript(document, { limit: 2 })).toEqual({
      items: document.cues.slice(0, 2),
      offset: 0,
      nextOffset: 2,
      total: 3,
    });
    expect(pageTranscript(document, { offset: 2, limit: 2 })).toEqual({
      items: [document.cues[2]],
      offset: 2,
      nextOffset: null,
      total: 3,
    });
    expect(pageTranscript(document, { offset: 3 })).toEqual({
      items: [],
      offset: 3,
      nextOffset: null,
      total: 3,
    });
    expect(document).toEqual(before);
  });

  it("locates keywords case-insensitively with cue indexes and bounded match pages", () => {
    const document = subtitle();
    const first = findTranscript(document, " synthetic ", { limit: 1 });
    expect(first).toEqual({
      items: [{ cueIndex: 0, cue: document.cues[0] }],
      offset: 0,
      nextOffset: 1,
      total: 2,
    });
    expect(
      findTranscript(document, "synthetic", { offset: first.nextOffset!, limit: 1 }).items[0]
        ?.cueIndex,
    ).toBe(1);
    expect(findTranscript(document, ".*").total).toBe(0);
    expect(findTranscript(document, "none").nextOffset).toBeNull();
    const accented = parseLrc("[00:01]Synthetic cafe\u0301");
    expect(findTranscript(accented, "CAFÉ").total).toBe(1);
  });

  it.each([
    { offset: -1 },
    { offset: 0.5 },
    { offset: Infinity },
    { offset: 10001 },
    { limit: 0 },
    { limit: 101 },
    { limit: 1.5 },
  ])("rejects invalid page options", (options) => {
    expect(() => pageTranscript(subtitle(), options)).toThrow("page");
    expect(() => findTranscript(subtitle(), "synthetic", options)).toThrow("page");
  });

  it.each(["", " ", "x".repeat(201)])("rejects unbounded or empty searches", (keyword) => {
    expect(() => findTranscript(subtitle(), keyword)).toThrow("keyword");
  });
});

describe("plain subtitle exports", () => {
  it("writes exact SRT and VTT blocks with correct fractional timestamp separators", () => {
    const document = subtitle();
    expect(serializeSrt(document)).toBe(
      "1\n00:00:01,125 --> 00:00:02,500\nSynthetic first\n\n2\n00:00:03,000 --> 00:00:04,001\nSynthetic SECOND\n\n3\n00:00:05,000 --> 00:00:06,000\nOther text\n\n",
    );
    expect(serializeVtt(document)).toBe(
      "WEBVTT\n\n1\n00:00:01.125 --> 00:00:02.500\nSynthetic first\n\n2\n00:00:03.000 --> 00:00:04.001\nSynthetic SECOND\n\n3\n00:00:05.000 --> 00:00:06.000\nOther text\n\n",
    );
  });

  it("requires explicit duration for unknown LRC ends and never invents tail timing", () => {
    const document = parseLrc("[00:01]Synthetic");
    expect(() => serializeSrt(document)).toThrow("end time");
    expect(() => serializeVtt(document, { durationMs: 1000 })).toThrow("end time");
    expect(serializeSrt(document, { durationMs: 3500 })).toContain("00:00:01,000 --> 00:00:03,500");
    expect(document.cues[0]?.endMs).toBeNull();
  });

  it("neutralizes markup, entity and line/timing injection while keeping input text untouched", () => {
    const attack =
      "<b>Synthetic</b> &lt;script&gt;\r\n\r\n00:01:00.000 --> 00:02:00.000\nInjected\u0000text";
    const document = parseBilibiliSubtitle(
      { body: [{ from: 0, to: 1, content: attack }] },
      { source: "author" },
    );
    const vtt = serializeVtt(document);
    expect(vtt).toContain("&lt;b&gt;Synthetic&lt;/b&gt; &amp;lt;script&amp;gt;");
    expect(vtt.match(/ --> /g)).toHaveLength(1);
    expect(vtt).toContain("00:01:00.000 --&gt; 00:02:00.000 Injected text");
    const srt = serializeSrt(document);
    expect(srt).toContain("‹b›Synthetic‹/b›");
    expect(srt.match(/ --> /g)).toHaveLength(1);
    expect(srt).not.toContain("<b>");
    expect(srt.split("\n\n").filter(Boolean)).toHaveLength(1);
    expect(document.cues[0]?.text).toBe(attack);
  });

  it("omits empty payloads, keeps numbering consecutive and formats hours", () => {
    const document = parseBilibiliSubtitle(
      {
        body: [
          { from: 0, to: 1, content: " \n" },
          { from: 3600.001, to: 3601.002, content: "Synthetic hour" },
        ],
      },
      { source: "author" },
    );
    expect(serializeSrt(document)).toBe("1\n01:00:00,001 --> 01:00:01,002\nSynthetic hour\n\n");
    expect(serializeSrt(parseLrc(""))).toBe("");
    expect(serializeVtt(parseLrc(""))).toBe("WEBVTT\n\n");
    expect(serializeSrt(parseLrc("[00:01]Synthetic\n[00:02]"))).toContain(
      "00:00:01,000 --> 00:00:02,000",
    );
  });

  it("revalidates caller-built ASR documents and rejects unsorted or malformed cues", () => {
    const document: TranscriptDocument = {
      language: "en",
      source: "asr",
      track: "original",
      cues: [{ startMs: 0, endMs: 1000, text: "Synthetic", uncertain: true }],
    };
    expect(serializeVtt(document)).toContain("Synthetic");
    const unsorted = { ...subtitle(), cues: [...subtitle().cues].reverse() };
    expect(() => serializeSrt(unsorted)).toThrow("sorted");
    expect(() => pageTranscript(unsorted)).toThrow("sorted");
    expect(() =>
      serializeVtt({ ...document, cues: [{ ...document.cues[0]!, uncertain: "yes" } as never] }),
    ).toThrow("flag");
    expect(() =>
      serializeSrt({ ...document, cues: [{ ...document.cues[0]!, endMs: Infinity }] }),
    ).toThrow("timestamp");
  });
});
