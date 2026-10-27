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

/** A turn owns opaque references and parsed subtitle promises; signed URLs never reach the model. */
export function createUniversalMediaClient(cookies?: string) {
  const videos = new Map<string, Promise<{ reference: string; video: ExtractedVideo }>>();
  const references = new Map<string, ExtractedVideo>();
  const tracks = new Map<string, ExtractedTrack>();
  const listings = new Map<string, ReturnType<typeof list>>();
  const documents = new Map<string, Promise<TranscriptDocument>>();
  function list(video: ExtractedVideo) {
    return video.tracks.map((track) => {
      const reference = randomUUID();
      tracks.set(reference, track);
      return { reference, language: track.language, label: track.label, source: track.source };
    });
  }
  return {
    async lookup(url: string, signal: AbortSignal) {
      const key = publicMediaUrl(url).href;
      let pending = videos.get(key);
      if (!pending) {
        if (videos.size >= 20) throw new YtdlpError("limit_exceeded");
        pending = inspectWithYtdlp(key, cookies, signal).then((video) => {
          signal.throwIfAborted();
          const reference = randomUUID();
          references.set(reference, video);
          return { reference, video };
        });
        videos.set(key, pending);
        pending.catch(() => {
          if (videos.get(key) === pending) videos.delete(key);
        });
      }
      const { reference, video } = await pending;
      const { tracks: _tracks, formats: _formats, ...metadata } = video;
      return {
        ...metadata,
        videoReference: reference,
        platform: video.extractor,
        subtitleCount: video.tracks.length,
        formatCount: video.formats.length,
        contentSource: "metadata_only",
      };
    },
    subtitles(reference: string, offset: number, limit: number) {
      const video = references.get(reference);
      if (!video) throw new YtdlpError("invalid_response");
      let listing = listings.get(reference);
      if (!listing) {
        listing = list(video);
        listings.set(reference, listing);
      }
      const next = offset + limit < listing.length ? offset + limit : null;
      return {
        status: listing.length ? "available" : "unavailable",
        reason: listing.length ? undefined : "no_subtitles_reported",
        tracks: listing.slice(offset, offset + limit),
        total: listing.length,
        nextOffset: next,
      };
    },
    formats(reference: string, offset: number, limit: number) {
      const video = references.get(reference);
      if (!video) throw new YtdlpError("invalid_response");
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
      const track = tracks.get(reference);
      if (!track) throw new YtdlpError("invalid_response");
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
            track: "original",
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
      return boundedTranscriptPage(await pending, input);
    },
    clear() {
      videos.clear();
      references.clear();
      tracks.clear();
      listings.clear();
      documents.clear();
    },
  };
}
