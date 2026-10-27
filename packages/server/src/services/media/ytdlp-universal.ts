import { randomUUID } from "node:crypto";
import {
  boundedTranscriptPage,
  pageTranscript,
  type TranscriptDocument,
} from "@cos-tool-bot/shared";
import { z } from "zod";
import { publicMediaUrl, readExtractorResponse } from "./http.js";
import { runYtdlpBridge, YtdlpError } from "./yt-dlp.js";
import { UNIVERSAL_YTDLP_SCRIPT } from "./ytdlp-universal-script.js";

const trackSchema = z.object({
  language: z.string().regex(/^[a-zA-Z0-9-]{1,64}$/),
  label: z.string().max(120),
  source: z.enum(["platform_cc", "platform_auto"]),
  isTranslated: z.boolean().default(false),
  originalLanguage: z
    .string()
    .regex(/^[a-zA-Z0-9-]{1,64}$/)
    .nullable()
    .default(null),
  translationGroup: z.string().max(64).nullable().default(null),
  ext: z.enum(["json3", "vtt", "srt", "ttml", "srv3", "json"]),
  url: z.string().max(8192).nullish(),
  data: z.string().max(1_000_000).nullish(),
  headers: z.record(z.string(), z.string()).default({}),
});
const videoSchema = z.object({
  id: z.string().min(1).max(300),
  extractor: z.string().min(1).max(100),
  url: z.string().max(8192),
  title: z.string().max(500),
  description: z.string().max(4000),
  author: z.string().max(200),
  durationSeconds: z.number().finite().nonnegative().nullable(),
  liveStatus: z.string().max(50).nullable(),
  originalLanguage: z
    .string()
    .regex(/^[a-zA-Z0-9-]{1,64}$/)
    .nullable()
    .default(null),
  chapters: z
    .array(
      z.object({
        title: z.string().max(200),
        startSeconds: z.number().nonnegative(),
        endSeconds: z.number().nonnegative().nullable(),
      }),
    )
    .max(100),
  tracks: z.array(trackSchema).max(2000),
  formats: z
    .array(
      z.object({
        format_id: z.string(),
        ext: z.string().nullish(),
        width: z.number().nullish(),
        height: z.number().nullish(),
        fps: z.number().nullish(),
        vcodec: z.string().nullish(),
        acodec: z.string().nullish(),
        filesize: z.number().nullish(),
        filesize_approx: z.number().nullish(),
        protocol: z.string().nullish(),
      }),
    )
    .max(200),
});
export type ExtractedVideo = z.infer<typeof videoSchema>;
type ExtractedTrack = z.infer<typeof trackSchema>;

function run(
  input: Record<string, unknown>,
  cookies: string | undefined,
  signal: AbortSignal,
  download = false,
) {
  return runYtdlpBridge({
    script: UNIVERSAL_YTDLP_SCRIPT,
    input: { ...input, cookies, nodePath: process.execPath },
    signal,
    timeoutMs: download ? 8 * 60_000 : 90_000,
    maxRequests: download ? 2000 : 200,
    maxBytes: download ? 160 * 1024 * 1024 : 48 * 1024 * 1024,
    read: (url, request, signal) =>
      readExtractorResponse(
        url,
        request,
        signal,
        download ? 50_000_000 : 8 * 1024 * 1024,
        input.operation === "inspect",
      ),
  });
}

export async function inspectWithYtdlp(
  url: string,
  cookies: string | undefined,
  signal: AbortSignal,
): Promise<ExtractedVideo> {
  const source = publicMediaUrl(url).href;
  const result = videoSchema.safeParse(
    await run({ operation: "inspect", url: source }, cookies, signal),
  );
  if (!result.success) throw new YtdlpError("invalid_response");
  publicMediaUrl(result.data.url);
  return result.data;
}

export async function downloadWithYtdlp(
  input: {
    url: string;
    expectedId: string;
    expectedExtractor: string;
    directory: string;
    maxBytes: number;
    maxSeconds: number;
  },
  cookies: string | undefined,
  signal: AbortSignal,
) {
  publicMediaUrl(input.url);
  const result = z
    .object({
      id: z.string(),
      extractor: z.string(),
      durationSeconds: z.number().positive().nullable(),
      separateAudio: z.boolean(),
      bytes: z.number().int().positive(),
    })
    .safeParse(await run({ operation: "download", ...input }, cookies, signal, true));
  if (
    !result.success ||
    result.data.bytes > input.maxBytes ||
    (result.data.durationSeconds !== null && result.data.durationSeconds > input.maxSeconds) ||
    result.data.id !== input.expectedId ||
    result.data.extractor !== input.expectedExtractor
  )
    throw new YtdlpError("invalid_response");
  return result.data;
}

export interface SubtitleFilters {
  language?: string;
  source?: ExtractedTrack["source"];
  includeTranslations?: boolean;
}

function matchesLanguage(language: string, requested: string) {
  return (
    language.toLowerCase() === requested.toLowerCase() ||
    language.toLowerCase().startsWith(`${requested.toLowerCase()}-`)
  );
}

function languagePreference(language: string, original: string | null) {
  if (!original || language.toLowerCase() === original.toLowerCase()) return 0;
  return language.split("-")[0]!.toLowerCase() === original.split("-")[0]!.toLowerCase() ? 1 : 2;
}

/** A turn owns opaque references and parsed subtitle promises; signed URLs never reach the model. */
export function createUniversalMediaClient(cookies?: string) {
  let scope = randomUUID();
  const videos = new Map<
    string,
    Promise<{ reference: string; video: ExtractedVideo; listing: ReturnType<typeof list> }>
  >();
  const references = new Map<string, { video: ExtractedVideo; listing: ReturnType<typeof list> }>();
  const tracks = new Map<string, ExtractedTrack>();
  const documents = new Map<string, Promise<TranscriptDocument>>();
  const referenceFor = (kind: "v" | "t") => `ytdlp:${scope}:${kind}:${randomUUID()}`;
  function resolve<T>(map: Map<string, T>, reference: string, kind: "v" | "t"): T {
    const value = map.get(reference);
    if (value !== undefined) return value;
    // The scope identifies stale references across turns/restarts without retaining old credentials.
    const parsed = /^ytdlp:([a-f0-9-]{36}):([vt]):[a-f0-9-]{36}$/.exec(reference);
    throw new YtdlpError(
      parsed && parsed[2] === kind && parsed[1] !== scope
        ? "reference_expired"
        : "unknown_reference",
    );
  }
  function list(video: ExtractedVideo) {
    const translationLanguages = new Map<string, Set<string>>();
    for (const track of video.tracks) {
      if (!track.isTranslated || !track.translationGroup) continue;
      const languages = translationLanguages.get(track.translationGroup) ?? new Set<string>();
      languages.add(track.language.toLowerCase());
      translationLanguages.set(track.translationGroup, languages);
    }
    return video.tracks
      .map((track) => {
        const reference = referenceFor("t");
        tracks.set(reference, track);
        return {
          reference,
          language: track.language,
          label: track.label,
          source: track.source,
          isTranslated: track.isTranslated,
          originalLanguage: track.originalLanguage,
          translationGroup: track.translationGroup,
          translationCount: track.translationGroup
            ? (translationLanguages.get(track.translationGroup)?.size ?? 0)
            : 0,
        };
      })
      .sort(
        (a, b) =>
          Number(a.source !== "platform_cc") - Number(b.source !== "platform_cc") ||
          Number(a.isTranslated) - Number(b.isTranslated) ||
          languagePreference(a.language, video.originalLanguage) -
            languagePreference(b.language, video.originalLanguage) ||
          a.language.localeCompare(b.language, "en") ||
          a.label.localeCompare(b.label, "en"),
      );
  }
  function present({ translationGroup: _group, ...track }: ReturnType<typeof list>[number]) {
    return track;
  }
  return {
    async lookup(url: string, signal: AbortSignal) {
      const lookupScope = scope;
      const key = publicMediaUrl(url).href;
      let pending = videos.get(key);
      if (!pending) {
        if (videos.size >= 20) throw new YtdlpError("limit_exceeded");
        pending = inspectWithYtdlp(key, cookies, signal).then((video) => {
          signal.throwIfAborted();
          if (scope !== lookupScope) throw new YtdlpError("reference_expired");
          const reference = referenceFor("v");
          const listing = list(video);
          references.set(reference, { video, listing });
          return { reference, video, listing };
        });
        videos.set(key, pending);
        pending.catch(() => {
          if (videos.get(key) === pending) videos.delete(key);
        });
      }
      const { reference, video, listing } = await pending;
      if (scope !== lookupScope) throw new YtdlpError("reference_expired");
      const primary = [...listing].sort(
        (a, b) =>
          Number(a.isTranslated) - Number(b.isTranslated) ||
          languagePreference(a.language, video.originalLanguage) -
            languagePreference(b.language, video.originalLanguage) ||
          Number(a.source !== "platform_cc") - Number(b.source !== "platform_cc"),
      )[0];
      const { tracks: _tracks, formats: _formats, ...metadata } = video;
      return {
        ...metadata,
        videoReference: reference,
        platform: video.extractor,
        subtitleCount: video.tracks.length,
        primaryTrackReference: primary?.reference ?? null,
        primaryTrack: primary ? present(primary) : null,
        formatCount: video.formats.length,
        contentSource: "metadata_only",
      };
    },
    subtitles(reference: string, offset: number, limit: number, filters: SubtitleFilters = {}) {
      const { listing } = resolve(references, reference, "v");
      const matching = listing.filter(
        (track) =>
          (!filters.language || matchesLanguage(track.language, filters.language)) &&
          (!filters.source || track.source === filters.source),
      );
      const groups = new Set(
        matching.filter((t) => !t.isTranslated).map((t) => t.translationGroup),
      );
      const visible =
        filters.includeTranslations || filters.language
          ? matching
          : matching.filter((track) => {
              if (!track.isTranslated || !track.translationGroup) return true;
              if (groups.has(track.translationGroup)) return false;
              // Keep one readable representative if the extractor omitted the group's original track.
              groups.add(track.translationGroup);
              return true;
            });
      return {
        status: visible.length ? "available" : "unavailable",
        reason: visible.length
          ? undefined
          : listing.length
            ? "no_matching_subtitles"
            : "no_subtitles_reported",
        tracks: visible.slice(offset, offset + limit).map(present),
        total: visible.length,
        hiddenTranslationCount: matching.length - visible.length,
        nextOffset: offset + limit < visible.length ? offset + limit : null,
      };
    },
    formats(reference: string, offset: number, limit: number) {
      const { video } = resolve(references, reference, "v");
      return {
        formats: video.formats.slice(offset, offset + limit),
        total: video.formats.length,
        nextOffset: offset + limit < video.formats.length ? offset + limit : null,
      };
    },
    async transcript(
      reference: string,
      input: { offset: number; limit: number; query?: string },
      signal: AbortSignal,
    ) {
      const track = resolve(tracks, reference, "t");
      let pending = documents.get(reference);
      if (!pending) {
        if (documents.size >= 20) throw new YtdlpError("limit_exceeded");
        pending = (async () => {
          if (track.url) publicMediaUrl(track.url);
          if (!track.url && !track.data) throw new YtdlpError("invalid_response");
          const value = await run(
            {
              operation: "subtitle",
              url: track.url,
              text: track.data,
              ext: track.ext,
              headers: track.headers,
            },
            cookies,
            signal,
          );
          if (!value || typeof value !== "object" || !("cues" in value))
            throw new YtdlpError("invalid_response");
          const document: TranscriptDocument = {
            language: track.language,
            source: track.source,
            track: track.isTranslated ? "translation" : "original",
            cues: value.cues as TranscriptDocument["cues"],
          };
          pageTranscript(document, { limit: 1 });
          return document;
        })();
        documents.set(reference, pending);
        pending.catch(() => {
          if (documents.get(reference) === pending) documents.delete(reference);
        });
      }
      const document = await pending;
      resolve(tracks, reference, "t");
      return boundedTranscriptPage(document, input);
    },
    clear() {
      scope = randomUUID();
      videos.clear();
      references.clear();
      tracks.clear();
      documents.clear();
    },
  };
}
