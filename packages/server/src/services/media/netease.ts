import { randomUUID } from "node:crypto";
import {
  parseLrc,
  type NeteaseCanonicalResource,
  type TranscriptDocument,
  type TranscriptTrack,
} from "@cos-tool-bot/shared";
import { readMediaDocument } from "./http.js";
import { resolveNeteaseResource } from "./resource.js";

export class NeteaseClientError extends Error {
  constructor(
    readonly code:
      | "invalid_response"
      | "api_rejected"
      | "login_required"
      | "unavailable"
      | "invalid_reference"
      | "reference_limit",
  ) {
    super(`NetEase request failed: ${code}`);
    this.name = "NeteaseClientError";
  }
}

export interface NeteaseArtist {
  id: number;
  name: string;
}

export interface NeteaseSong {
  reference: string;
  id: number;
  url: string;
  title: string;
  artists: NeteaseArtist[];
  album: { id: number; title: string; url: string } | null;
  durationMs: number | null;
}

export type NeteaseResource =
  | (NeteaseSong & { resourceType: "song" })
  | {
      resourceType: "album" | "playlist";
      id: number;
      url: string;
      title: string;
      description: string;
      artists: NeteaseArtist[];
      tracks: {
        items: NeteaseSong[];
        /** null when the compatibility response does not establish an upstream total. */
        total: number | null;
        complete: boolean;
        truncated: boolean;
        nextOffset: null;
        upstreamPaginationAvailable: false;
      };
    };

export type NeteaseLyrics =
  | {
      status: "available";
      tracks: TranscriptDocument[];
      missingTracks: TranscriptTrack[];
      /** A full bounded response does not prove that the platform supplied every lyric. */
      completeness: "upstream_unverified";
    }
  | { status: "instrumental" }
  | { status: "unavailable"; reason: "not_collected" | "not_provided" };

const ORIGIN = "https://music.163.com";
const MAX_REFERENCES = 100;
const MAX_RETURNED_TRACKS = 100;
const MAX_UPSTREAM_TRACKS = 10_000;
const MAX_DURATION_MS = 86_400_000;

function invalid(): never {
  throw new NeteaseClientError("invalid_response");
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid();
  return value as Record<string, unknown>;
}

function integer(value: unknown, min = 1, max = Number.MAX_SAFE_INTEGER): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < min || value > max)
    invalid();
  return value;
}

function text(value: unknown, max: number): string {
  if (typeof value !== "string") invalid();
  return value.slice(0, max);
}

function artists(value: unknown): NeteaseArtist[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 100) invalid();
  return value.map((raw) => {
    const artist = object(raw);
    return { id: integer(artist.id), name: text(artist.name, 256) };
  });
}

function song(raw: unknown): NeteaseSong {
  const data = object(raw);
  const id = integer(data.id);
  const albumData = data.album ?? data.al;
  const album = albumData === undefined || albumData === null ? null : object(albumData);
  const albumId = album ? integer(album.id) : null;
  const duration = data.duration ?? data.dt;
  return {
    reference: randomUUID(),
    id,
    url: `${ORIGIN}/song?id=${id}`,
    title: text(data.name, 300),
    artists: artists(data.artists ?? data.ar),
    album:
      album && albumId
        ? { id: albumId, title: text(album.name, 300), url: `${ORIGIN}/album?id=${albumId}` }
        : null,
    durationMs: duration === undefined ? null : integer(duration, 0, MAX_DURATION_MS),
  };
}

function lyric(data: Record<string, unknown>, key: string): string | null {
  if (data[key] === undefined || data[key] === null) return null;
  const track = object(data[key]);
  if (track.lyric === undefined || track.lyric === null || track.lyric === "") return null;
  if (typeof track.lyric !== "string" || track.lyric.length > 500_000) invalid();
  return track.lyric.trim() ? track.lyric : null;
}

/** Read-only compatibility API, not a stable official platform contract:
 * Song metadata/lyrics: https://github.com/yt-dlp/yt-dlp/blob/master/yt_dlp/extractor/neteasemusic.py
 * Legacy album/playlist GET: https://github.com/ytdl-org/youtube-dl/blob/master/youtube_dl/extractor/neteasemusic.py
 * Romanization: https://github.com/neteasecloudmusicapienhanced/api-enhanced/blob/master/module/lyric.js
 * Construct once per authorized turn and credential scope. The legacy collection endpoints may
 * be unavailable; never fall back to encrypted APIs, player URLs or access-control workarounds.
 */
export function createNeteaseClient(config: { cookie?: string } = {}) {
  const cookie = config.cookie;
  const references = new Map<string, { id: number; durationMs: number | null }>();

  async function api(path: string, parameters: Record<string, string>, signal?: AbortSignal) {
    signal?.throwIfAborted();
    const url = new URL(path, ORIGIN);
    url.search = new URLSearchParams(parameters).toString();
    const response = await readMediaDocument(url.href, {
      allowedHosts: ["music.163.com"],
      mimeTypes: ["application/json"],
      maxBytes: 2 * 1024 * 1024,
      maxRedirects: 0,
      credential: cookie ? { origin: ORIGIN, cookie } : undefined,
      signal,
    });
    signal?.throwIfAborted();
    let envelope: Record<string, unknown>;
    try {
      envelope = object(JSON.parse(response.bytes.toString("utf8")));
    } catch {
      return invalid();
    }
    const code = integer(envelope.code, -1_000_000, 1_000_000);
    if (code === 301 || code === -462) throw new NeteaseClientError("login_required");
    if (code === 404 || code === 410) throw new NeteaseClientError("unavailable");
    if (code !== 200) throw new NeteaseClientError("api_rejected");
    return envelope;
  }

  function remember(items: NeteaseSong[], signal?: AbortSignal) {
    signal?.throwIfAborted();
    // Check after I/O as well: concurrent requests share this single per-turn bound.
    if (references.size + items.length > MAX_REFERENCES)
      throw new NeteaseClientError("reference_limit");
    for (const item of items)
      references.set(item.reference, { id: item.id, durationMs: item.durationMs });
  }

  async function collection(
    resource: NeteaseCanonicalResource,
    signal?: AbortSignal,
  ): Promise<NeteaseResource> {
    const isAlbum = resource.resourceType === "album";
    const envelope = await api(
      isAlbum ? `/api/album/${resource.id}` : "/api/playlist/detail",
      isAlbum ? { id: String(resource.id) } : { id: String(resource.id), lv: "-1", tv: "-1" },
      signal,
    );
    const data = object(isAlbum ? envelope.album : envelope.result);
    if (integer(data.id) !== resource.id) invalid();
    const rawTracks = isAlbum ? (data.songs ?? envelope.songs) : data.tracks;
    if (!Array.isArray(rawTracks) || rawTracks.length > MAX_UPSTREAM_TRACKS) invalid();
    const items = rawTracks.slice(0, MAX_RETURNED_TRACKS).map(song);
    if (new Set(items.map((item) => item.id)).size !== items.length) invalid();
    const rawTotal = isAlbum ? data.size : data.trackCount;
    const total = rawTotal === undefined ? null : integer(rawTotal, 0, 1_000_000);
    if (total !== null && total < rawTracks.length) invalid();
    const result: NeteaseResource = {
      resourceType: isAlbum ? "album" : "playlist",
      id: resource.id,
      url: resource.canonicalUrl,
      title: text(data.name, 300),
      description: data.description == null ? "" : text(data.description, 8000),
      artists: isAlbum ? artists(data.artists ?? (data.artist ? [data.artist] : undefined)) : [],
      tracks: {
        items,
        total,
        complete: total !== null && total === items.length,
        truncated: rawTracks.length > items.length || (total !== null && total > items.length),
        nextOffset: null,
        upstreamPaginationAvailable: false,
      },
    };
    remember(items, signal);
    return result;
  }

  async function getResource(input: string, signal?: AbortSignal): Promise<NeteaseResource> {
    signal?.throwIfAborted();
    if (references.size >= MAX_REFERENCES) throw new NeteaseClientError("reference_limit");
    const resource = await resolveNeteaseResource(input, signal);
    if (resource.resourceType !== "song") return collection(resource, signal);
    const data = await api(
      "/api/song/detail",
      { id: String(resource.id), ids: `[${resource.id}]` },
      signal,
    );
    if (!Array.isArray(data.songs)) invalid();
    if (!data.songs.length) throw new NeteaseClientError("unavailable");
    if (data.songs.length !== 1) invalid();
    const item = song(data.songs[0]);
    if (item.id !== resource.id) invalid();
    remember([item], signal);
    return { resourceType: "song", ...item };
  }

  async function getLyrics(reference: string, signal?: AbortSignal): Promise<NeteaseLyrics> {
    signal?.throwIfAborted();
    const item = references.get(reference);
    if (!item) throw new NeteaseClientError("invalid_reference");
    const data = await api(
      "/api/song/lyric",
      { id: String(item.id), lv: "-1", tv: "-1", rv: "-1" },
      signal,
    );
    for (const key of ["nolyric", "uncollected"]) {
      if (data[key] !== undefined && typeof data[key] !== "boolean") invalid();
    }
    const original = lyric(data, "lrc");
    const translation = lyric(data, "tlyric");
    const romanization = lyric(data, "romalrc");
    const instrumentalMarker = original?.trim() === "[99:00.00]纯音乐，请欣赏";
    if (data.nolyric === true || instrumentalMarker) {
      if ((original && !instrumentalMarker) || translation || romanization || data.uncollected)
        invalid();
      return { status: "instrumental" };
    }
    if (data.uncollected === true) {
      if (original || translation || romanization) invalid();
      return { status: "unavailable", reason: "not_collected" };
    }
    const tracks: TranscriptDocument[] = [];
    const missingTracks: TranscriptTrack[] = [];
    for (const [track, content] of [
      ["original", original],
      ["translation", translation],
      ["romanization", romanization],
    ] as const) {
      if (!content) {
        missingTracks.push(track);
        continue;
      }
      try {
        const document = parseLrc(content, {
          track,
          durationMs: item.durationMs || undefined,
          bounds: { maxInputChars: 500_000, maxTextChars: 300_000, maxCueChars: 4096 },
        });
        if (!document.cues.length || !document.cues.some((cue) => cue.text.trim())) invalid();
        tracks.push(document);
      } catch {
        return invalid();
      }
    }
    signal?.throwIfAborted();
    if (!tracks.length) return { status: "unavailable", reason: "not_provided" };
    return { status: "available", tracks, missingTracks, completeness: "upstream_unverified" };
  }

  return { getResource, getLyrics };
}
