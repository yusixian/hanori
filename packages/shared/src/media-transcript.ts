export type TranscriptSource = "author" | "platform_cc" | "platform_auto" | "asr" | "lyrics";
export type TranscriptTrack = "original" | "translation" | "romanization";

export interface TranscriptCue {
  startMs: number;
  /** null means the source provides no end time; exports require an explicit media duration. */
  endMs: number | null;
  /** Untrusted plain text. Consumers must render it as text, never HTML or instructions. */
  text: string;
  /** Recognition uncertainty, for example an ASR engine's assessment of the words. */
  uncertain?: boolean;
  /** Timing inferred from the next LRC timestamp/media duration, not recognition uncertainty. */
  timingInferred?: boolean;
}

export interface TranscriptDocument {
  language: string | null;
  source: TranscriptSource;
  track: TranscriptTrack;
  cues: TranscriptCue[];
}

export interface TranscriptBounds {
  maxInputChars: number;
  maxCues: number;
  maxCueChars: number;
  maxTextChars: number;
  maxTimeMs: number;
}

export const TRANSCRIPT_BOUNDS: Readonly<TranscriptBounds> = Object.freeze({
  maxInputChars: 1_000_000,
  maxCues: 10_000,
  maxCueChars: 16_384,
  maxTextChars: 500_000,
  maxTimeMs: 86_400_000,
});

export interface TranscriptParseOptions {
  language?: string;
  track?: TranscriptTrack;
  /** Limits count UTF-16 code units. Overrides may only reduce the hard limits. */
  bounds?: Partial<TranscriptBounds>;
}

export interface LrcParseOptions extends TranscriptParseOptions {
  durationMs?: number;
}

export interface BilibiliSubtitleOptions extends TranscriptParseOptions {
  /** Determined by the host from metadata, never cue text. platform_cc does not assert human authorship. */
  source: "author" | "platform_cc" | "platform_auto";
}

export interface TranscriptPageOptions {
  /** Stable against an unchanged document. The host pins its document/track revision. */
  offset?: number;
  limit?: number;
}

export interface TranscriptPage<T> {
  items: T[];
  offset: number;
  nextOffset: number | null;
  total: number;
}

export interface TranscriptMatch {
  cueIndex: number;
  cue: TranscriptCue;
}

export class TranscriptError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TranscriptError";
  }
}

function limits(overrides: Partial<TranscriptBounds> = {}): TranscriptBounds {
  const result = { ...TRANSCRIPT_BOUNDS };
  for (const key of Object.keys(TRANSCRIPT_BOUNDS) as Array<keyof TranscriptBounds>) {
    const value = overrides[key] ?? TRANSCRIPT_BOUNDS[key];
    if (!Number.isSafeInteger(value) || value < 1 || value > TRANSCRIPT_BOUNDS[key])
      throw new TranscriptError("Invalid transcript limit");
    result[key] = value;
  }
  return result;
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function time(value: unknown, bounds: TranscriptBounds): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) < 0 || (value as number) > bounds.maxTimeMs)
    throw new TranscriptError("Invalid transcript timestamp");
}

function metadata(options: TranscriptParseOptions, source: TranscriptSource) {
  const language = options.language ?? null;
  const track = options.track ?? "original";
  if (language !== null && (typeof language !== "string" || !/^[a-zA-Z0-9-]{1,64}$/.test(language)))
    throw new TranscriptError("Invalid transcript language");
  if (!["original", "translation", "romanization"].includes(track))
    throw new TranscriptError("Invalid transcript track");
  if (!["author", "platform_cc", "platform_auto", "asr", "lyrics"].includes(source))
    throw new TranscriptError("Invalid transcript source");
  return { language, source, track };
}

function validateCues(cues: TranscriptCue[], bounds: TranscriptBounds) {
  if (!Array.isArray(cues) || cues.length > bounds.maxCues)
    throw new TranscriptError("Transcript cue limit exceeded");
  let total = 0;
  let previous = -1;
  for (const cue of cues) {
    if (!record(cue)) throw new TranscriptError("Invalid transcript cue");
    time(cue.startMs, bounds);
    if (cue.startMs < previous) throw new TranscriptError("Transcript cues must be sorted");
    previous = cue.startMs;
    if (cue.endMs !== null) {
      time(cue.endMs, bounds);
      if (cue.endMs <= cue.startMs) throw new TranscriptError("Invalid transcript interval");
    }
    if (typeof cue.text !== "string" || cue.text.length > bounds.maxCueChars)
      throw new TranscriptError("Transcript cue text limit exceeded");
    for (const flag of [cue.uncertain, cue.timingInferred]) {
      if (flag !== undefined && typeof flag !== "boolean")
        throw new TranscriptError("Invalid transcript uncertainty flag");
    }
    total += cue.text.length;
    if (total > bounds.maxTextChars) throw new TranscriptError("Transcript text limit exceeded");
  }
}

function validateDocument(document: TranscriptDocument) {
  if (!record(document)) throw new TranscriptError("Invalid transcript document");
  metadata({ language: document.language ?? undefined, track: document.track }, document.source);
  validateCues(document.cues, TRANSCRIPT_BOUNDS);
}

function lrcTime(tag: string, bounds: TranscriptBounds): number {
  const match = /^(\d{1,4}):([0-5]?\d)(?:[.:](\d{1,3}))?$/.exec(tag);
  if (!match) throw new TranscriptError("Invalid LRC timestamp");
  const value =
    Number(match[1]) * 60_000 + Number(match[2]) * 1_000 + Number((match[3] ?? "").padEnd(3, "0"));
  time(value, bounds);
  return value;
}

/** Simple line-level LRC, including multiple tags, ID metadata and signed millisecond offset.
 * Positive offset displays lyrics sooner (start - offset). Enhanced word tags remain plain text.
 * Inferred ends use the next distinct start; trailing cues remain unknown without media duration.
 */
export function parseLrc(input: string, options: LrcParseOptions = {}): TranscriptDocument {
  const bounds = limits(options.bounds);
  if (typeof input !== "string" || input.length > bounds.maxInputChars)
    throw new TranscriptError("LRC input limit exceeded");
  if (options.durationMs !== undefined) time(options.durationMs, bounds);
  const cues: TranscriptCue[] = [];
  let offset = 0;
  let textChars = 0;
  for (const raw of input.replace(/^\uFEFF/, "").split(/\r\n|\r|\n/)) {
    const line = raw.trimStart();
    if (!line.trim()) continue;
    const metadataTag = /^\[([a-zA-Z][a-zA-Z0-9_-]*):(.*)\]\s*$/.exec(line);
    if (metadataTag) {
      if (metadataTag[1]!.toLowerCase() === "offset") {
        const value = metadataTag[2]!.trim();
        if (!/^[+-]?\d{1,9}$/.test(value) || Math.abs(Number(value)) > bounds.maxTimeMs)
          throw new TranscriptError("Invalid LRC offset");
        offset = Number(value);
      }
      continue;
    }
    const timestamps: number[] = [];
    let position = 0;
    while (line[position] === "[") {
      const end = line.indexOf("]", position + 1);
      if (end === -1) throw new TranscriptError("Invalid LRC timestamp tag");
      const tag = line.slice(position + 1, end);
      if (!/^\d/.test(tag)) break;
      timestamps.push(lrcTime(tag, bounds));
      if (timestamps.length + cues.length > bounds.maxCues)
        throw new TranscriptError("Transcript cue limit exceeded");
      position = end + 1;
    }
    if (timestamps.length === 0) throw new TranscriptError("LRC line has no timestamp");
    const text = line.slice(position);
    if (text.length > bounds.maxCueChars)
      throw new TranscriptError("Transcript cue text limit exceeded");
    textChars += text.length * timestamps.length;
    if (textChars > bounds.maxTextChars)
      throw new TranscriptError("Transcript text limit exceeded");
    for (const startMs of timestamps)
      cues.push({ startMs, endMs: null, text, timingInferred: true });
  }
  for (const cue of cues) {
    cue.startMs -= offset;
    time(cue.startMs, bounds);
  }
  cues.sort((a, b) => a.startMs - b.startMs);
  let nextStart = options.durationMs ?? null;
  for (let index = cues.length - 1; index >= 0; index--) {
    const cue = cues[index]!;
    const next = cues[index + 1];
    if (next && next.startMs > cue.startMs) nextStart = next.startMs;
    cue.endMs = nextStart;
  }
  validateCues(cues, bounds);
  return { ...metadata(options, "lyrics"), cues };
}

/** Fixed BCC subset: {body:[{from,to,content}]}, times in seconds. This does not verify the
 * platform API or provenance. The host must bound response bytes before JSON parsing and
 * determine subtitle provenance from platform metadata. Other JSON fields are ignored.
 */
export function parseBilibiliSubtitle(
  input: unknown,
  options: BilibiliSubtitleOptions,
): TranscriptDocument {
  const bounds = limits(options.bounds);
  if (!record(input) || !Array.isArray(input.body) || input.body.length > bounds.maxCues)
    throw new TranscriptError("Invalid Bilibili subtitle body");
  if (!["author", "platform_cc", "platform_auto"].includes(options.source))
    throw new TranscriptError("Bilibili subtitle source is required");
  let total = 0;
  const cues = input.body.map((item: unknown): TranscriptCue => {
    if (
      !record(item) ||
      typeof item.from !== "number" ||
      typeof item.to !== "number" ||
      !Number.isFinite(item.from) ||
      !Number.isFinite(item.to) ||
      item.from < 0 ||
      item.to <= item.from ||
      item.to > bounds.maxTimeMs / 1_000 ||
      typeof item.content !== "string" ||
      item.content.length > bounds.maxCueChars
    )
      throw new TranscriptError("Invalid Bilibili subtitle cue");
    total += item.content.length;
    if (total > bounds.maxTextChars || total > bounds.maxInputChars)
      throw new TranscriptError("Transcript text limit exceeded");
    return {
      startMs: Math.round(item.from * 1_000),
      endMs: Math.round(item.to * 1_000),
      text: item.content,
    };
  });
  cues.sort((a, b) => a.startMs - b.startMs);
  validateCues(cues, bounds);
  return { ...metadata(options, options.source), cues };
}

function pageOptions(options: TranscriptPageOptions) {
  const offset = options.offset ?? 0;
  const limit = options.limit ?? 50;
  if (
    !Number.isSafeInteger(offset) ||
    offset < 0 ||
    offset > TRANSCRIPT_BOUNDS.maxCues ||
    !Number.isSafeInteger(limit) ||
    limit < 1 ||
    limit > 100
  )
    throw new TranscriptError("Invalid transcript page");
  return { offset, limit };
}

function pageItems<T>(items: T[], options: TranscriptPageOptions): TranscriptPage<T> {
  const { offset, limit } = pageOptions(options);
  return {
    items: items.slice(offset, offset + limit),
    offset,
    nextOffset: offset + limit < items.length ? offset + limit : null,
    total: items.length,
  };
}

export function pageTranscript(
  document: TranscriptDocument,
  options: TranscriptPageOptions = {},
): TranscriptPage<TranscriptCue> {
  validateDocument(document);
  return pageItems(document.cues, options);
}

/** Literal case-insensitive search, one location per matching cue, in stable cue order. */
export function findTranscript(
  document: TranscriptDocument,
  keyword: string,
  options: TranscriptPageOptions = {},
): TranscriptPage<TranscriptMatch> {
  validateDocument(document);
  if (typeof keyword !== "string" || keyword.trim().length === 0 || keyword.length > 200)
    throw new TranscriptError("Invalid transcript keyword");
  const needle = keyword.trim().normalize("NFC").toLowerCase();
  const matches: TranscriptMatch[] = [];
  for (const [cueIndex, cue] of document.cues.entries()) {
    if (cue.text.normalize("NFC").toLowerCase().includes(needle)) matches.push({ cueIndex, cue });
  }
  return pageItems(matches, options);
}

function timestamp(ms: number, separator: "." | ",") {
  const hours = Math.floor(ms / 3_600_000);
  const minutes = Math.floor(ms / 60_000) % 60;
  const seconds = Math.floor(ms / 1_000) % 60;
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}${separator}${String(ms % 1_000).padStart(3, "0")}`;
}

export interface TranscriptExportOptions {
  /** Host-verified media duration, used only where an end time is missing. No duration is guessed. */
  durationMs?: number;
}

function serialize(
  document: TranscriptDocument,
  format: "srt" | "vtt",
  options: TranscriptExportOptions,
) {
  validateDocument(document);
  if (options.durationMs !== undefined) time(options.durationMs, TRANSCRIPT_BOUNDS);
  const blocks: string[] = [];
  for (const cue of document.cues) {
    // One payload line prevents blank-line/timing injection. VTT escapes preserve literal markup;
    // SRT has no standard escape mechanism, so angle brackets become visible Unicode equivalents.
    // oxlint-disable-next-line no-control-regex
    const plain = cue.text.replace(/[\u0000-\u0020\u007f\u2028\u2029]+/g, " ").trim();
    if (!plain) continue;
    const endMs = cue.endMs ?? options.durationMs;
    if (endMs === undefined || endMs <= cue.startMs)
      throw new TranscriptError("Subtitle export requires a valid cue end time");
    const text =
      format === "vtt"
        ? plain.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
        : plain.replace(/</g, "‹").replace(/>/g, "›");
    blocks.push(
      `${blocks.length + 1}\n${timestamp(cue.startMs, format === "srt" ? "," : ".")} --> ${timestamp(endMs, format === "srt" ? "," : ".")}\n${text}`,
    );
  }
  return (
    (format === "vtt" ? "WEBVTT\n\n" : "") + (blocks.length ? blocks.join("\n\n") + "\n\n" : "")
  );
}

/** Pure conversion. The host must authorize access/export before invoking and delivering output. */
export function serializeSrt(
  document: TranscriptDocument,
  options: TranscriptExportOptions = {},
): string {
  return serialize(document, "srt", options);
}

/** Pure conversion. The host must authorize access/export before invoking and delivering output. */
export function serializeVtt(
  document: TranscriptDocument,
  options: TranscriptExportOptions = {},
): string {
  return serialize(document, "vtt", options);
}

/** Bounded excerpts for tools and the web panel; full export is authorized separately. */
export function boundedTranscriptPage(
  document: TranscriptDocument,
  input: { offset: number; limit: number; query?: string },
) {
  if (input.limit > 40) throw new TranscriptError("Invalid transcript excerpt limit");
  const page = input.query
    ? findTranscript(document, input.query, input)
    : pageTranscript(document, input);
  const cues: Array<{
    cueIndex: number;
    startMs: number;
    endMs: number | null;
    text: string;
    uncertain?: boolean;
    timingInferred?: boolean;
    textTruncated?: boolean;
  }> = [];
  let textChars = 0;
  let textTruncated = false;
  for (const [index, item] of page.items.entries()) {
    const match = "cue" in item ? item : { cueIndex: input.offset + index, cue: item };
    const remaining = 4000 - textChars;
    if (remaining <= 0 || (cues.length && match.cue.text.length > remaining)) break;
    const clipped = match.cue.text.length > remaining;
    const text = match.cue.text.slice(0, remaining);
    cues.push({
      cueIndex: match.cueIndex,
      ...match.cue,
      text,
      ...(clipped ? { textTruncated: true } : {}),
    });
    textChars += text.length;
    textTruncated ||= clipped;
  }
  const nextOffset = input.offset + cues.length < page.total ? input.offset + cues.length : null;
  return {
    status: "available" as const,
    source: document.source,
    track: document.track,
    language: document.language,
    cues,
    offset: input.offset,
    total: page.total,
    nextOffset,
    hasMore: nextOffset !== null,
    textTruncated,
  };
}
