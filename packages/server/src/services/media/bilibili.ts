import { createHash, randomUUID } from "node:crypto";
import { parseBilibiliSubtitle, type TranscriptDocument } from "@cos-tool-bot/shared";
import { readMediaDocument } from "./http.js";
import { resolveBilibiliResource } from "./resource.js";

export class BilibiliClientError extends Error {
  constructor(
    readonly code: "invalid_response" | "api_rejected" | "invalid_reference" | "reference_limit",
  ) {
    super(`Bilibili request failed: ${code}`);
    this.name = "BilibiliClientError";
  }
}

export interface BilibiliPart {
  part: number;
  title: string;
  durationSeconds: number;
}

export interface BilibiliVideo {
  reference: string;
  url: string;
  aid: number;
  bvid: string;
  title: string;
  description: string;
  author: { id: number; name: string; url: string };
  durationSeconds: number;
  publishedAt: number;
  selectedPart: number;
  parts: BilibiliPart[];
}

export interface BilibiliSubtitleTrack {
  reference: string;
  language: string;
  label: string;
  source: "platform_cc" | "platform_auto";
}

export type BilibiliSubtitleListing =
  | { status: "available"; tracks: BilibiliSubtitleTrack[] }
  | { status: "none" | "login_required" | "authentication_unconfirmed" };

const API_ORIGIN = "https://api.bilibili.com";
// Current/older platform response hosts observed by yt-dlp; an unfamiliar CDN fails closed.
const SUBTITLE_HOSTS = ["aisubtitle.hdslb.com", "i0.hdslb.com", "i1.hdslb.com", "i2.hdslb.com"];
const BV = /^BV1[A-Za-z0-9]{9}$/;

function invalid(): never {
  throw new BilibiliClientError("invalid_response");
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

function json(bytes: Buffer): Record<string, unknown> {
  try {
    return object(JSON.parse(bytes.toString("utf8")));
  } catch {
    return invalid();
  }
}

function subtitleUrl(value: unknown): string {
  if (typeof value !== "string" || !value || value.length > 4096 || /[\s\\]/u.test(value))
    invalid();
  for (const character of value) {
    const code = character.charCodeAt(0);
    if (code < 0x20 || code === 0x7f) invalid();
  }
  try {
    const url = new URL(value.startsWith("//") ? `https:${value}` : value);
    if (
      url.protocol !== "https:" ||
      url.username ||
      url.password ||
      url.port ||
      !SUBTITLE_HOSTS.includes(url.hostname)
    )
      invalid();
    return url.href;
  } catch {
    return invalid();
  }
}

/** Compatibility adapter based on yt-dlp's Bilibili implementation, not an official API contract:
 * https://github.com/yt-dlp/yt-dlp/blob/master/yt_dlp/extractor/bilibili.py
 * Construct once per authorized turn/Bot credential scope. No access-control fallback.
 */
export function createBilibiliClient(config: { cookie?: string } = {}) {
  const cookie = config.cookie;
  const videos = new Map<
    string,
    { aid: number; cid: number; bvid: string; duration: number; downloadable: boolean }
  >();
  const tracks = new Map<
    string,
    { url: string; language: string; source: BilibiliSubtitleTrack["source"] }
  >();

  async function api(path: string, parameters: Record<string, string>, signal?: AbortSignal) {
    signal?.throwIfAborted();
    const url = new URL(path, API_ORIGIN);
    url.search = new URLSearchParams(parameters).toString();
    const response = await readMediaDocument(url.href, {
      allowedHosts: ["api.bilibili.com"],
      mimeTypes: ["application/json"],
      maxBytes: 2 * 1024 * 1024,
      credential: cookie ? { origin: API_ORIGIN, cookie } : undefined,
      signal,
    });
    signal?.throwIfAborted();
    const envelope = json(response.bytes);
    if (typeof envelope.code !== "number" || !Number.isSafeInteger(envelope.code)) invalid();
    if (path === "/x/web-interface/nav" && envelope.code === -101) {
      if (object(envelope.data).isLogin !== false) invalid();
      return object(envelope.data);
    }
    if (envelope.code !== 0) throw new BilibiliClientError("api_rejected");
    return object(envelope.data);
  }

  async function getVideo(input: string, signal?: AbortSignal): Promise<BilibiliVideo> {
    signal?.throwIfAborted();
    if (videos.size >= 20) throw new BilibiliClientError("reference_limit");
    const resource = await resolveBilibiliResource(input, signal);
    const data = await api(
      "/x/web-interface/view",
      {
        [resource.idType === "av" ? "aid" : "bvid"]: String(resource.id),
      },
      signal,
    );
    const aid = integer(data.aid);
    const bvid = typeof data.bvid === "string" && BV.test(data.bvid) ? data.bvid : invalid();
    if (resource.idType === "av" ? resource.id !== aid : resource.id !== bvid) invalid();
    if (!Array.isArray(data.pages) || !data.pages.length || data.pages.length > 1000) invalid();
    const pages = data.pages.map((raw) => {
      const page = object(raw);
      return {
        part: integer(page.page, 1, 1000),
        cid: integer(page.cid),
        title: text(page.part, 300),
        durationSeconds: integer(page.duration, 0, Math.floor(Number.MAX_SAFE_INTEGER / 1000)),
      };
    });
    if (new Set(pages.map((page) => page.part)).size !== pages.length) invalid();
    const selected = pages.find((page) => page.part === resource.part);
    if (!selected) invalid();
    const owner = object(data.owner);
    const ownerId = integer(owner.mid);
    const video = {
      reference: randomUUID(),
      url: resource.canonicalUrl,
      aid,
      bvid,
      title: text(data.title, 300),
      description: text(data.desc, 8000),
      author: {
        id: ownerId,
        name: text(owner.name, 256),
        url: `https://space.bilibili.com/${ownerId}`,
      },
      durationSeconds: integer(data.duration, 0, Math.floor(Number.MAX_SAFE_INTEGER / 1000)),
      publishedAt: integer(data.pubdate, 0, 253_402_300_799),
      selectedPart: resource.part,
      parts: pages.map(({ cid: _cid, ...part }) => part),
    };
    signal?.throwIfAborted();
    // Concurrent requests share the same bound, including after the network completes.
    if (videos.size >= 20) throw new BilibiliClientError("reference_limit");
    videos.set(video.reference, {
      aid,
      cid: selected.cid,
      bvid,
      duration: selected.durationSeconds,
      downloadable:
        !!data.rights &&
        typeof data.rights === "object" &&
        !Array.isArray(data.rights) &&
        (data.rights as Record<string, unknown>).download === 1,
    });
    return video;
  }

  async function listSubtitles(
    reference: string,
    signal?: AbortSignal,
  ): Promise<BilibiliSubtitleListing> {
    signal?.throwIfAborted();
    const video = videos.get(reference);
    if (!video) throw new BilibiliClientError("invalid_reference");
    const data = await api(
      "/x/player/wbi/v2",
      { aid: String(video.aid), cid: String(video.cid) },
      signal,
    );
    if (data.need_login_subtitle === true) return { status: "login_required" };
    if (data.need_login_subtitle !== undefined && data.need_login_subtitle !== false) invalid();
    if (data.aid !== undefined && data.aid !== video.aid) invalid();
    if (data.cid !== undefined && data.cid !== video.cid) invalid();
    const subtitle = object(data.subtitle);
    if (!Array.isArray(subtitle.subtitles) || subtitle.subtitles.length > 100) invalid();
    if (subtitle.subtitles.length === 0) {
      if (!cookie) return { status: "authentication_unconfirmed" };
      const navigation = await api("/x/web-interface/nav", {}, signal);
      if (navigation.isLogin === false) return { status: "login_required" };
      if (navigation.isLogin !== true) invalid();
      return { status: "none" };
    }
    const pending = subtitle.subtitles.map((raw) => {
      const item = object(raw);
      if (typeof item.lan !== "string" || !/^[a-zA-Z0-9-]{1,64}$/.test(item.lan)) invalid();
      const source: BilibiliSubtitleTrack["source"] = item.lan.startsWith("ai-")
        ? "platform_auto"
        : "platform_cc";
      return {
        reference: randomUUID(),
        language: item.lan,
        label: text(item.lan_doc, 256),
        source,
        url: subtitleUrl(item.subtitle_url),
      };
    });
    signal?.throwIfAborted();
    if (tracks.size + pending.length > 100) throw new BilibiliClientError("reference_limit");
    for (const track of pending) tracks.set(track.reference, track);
    return {
      status: "available",
      tracks: pending.map(({ reference: trackReference, language, label, source }) => ({
        reference: trackReference,
        language,
        label,
        source,
      })),
    };
  }

  async function readSubtitle(
    reference: string,
    signal?: AbortSignal,
  ): Promise<TranscriptDocument> {
    signal?.throwIfAborted();
    const track = tracks.get(reference);
    if (!track) throw new BilibiliClientError("invalid_reference");
    const response = await readMediaDocument(track.url, {
      allowedHosts: SUBTITLE_HOSTS,
      mimeTypes: ["application/json", "text/plain"],
      maxBytes: 2 * 1024 * 1024,
      signal,
    });
    signal?.throwIfAborted();
    try {
      return parseBilibiliSubtitle(json(response.bytes), {
        source: track.source,
        language: track.language,
      });
    } catch {
      return invalid();
    }
  }

  /** Host-only audio-job operation. Signed CDN URLs must never enter model tools or logs. */
  async function getAudio(
    reference: string,
    signal?: AbortSignal,
    maxDurationSeconds = Number.MAX_SAFE_INTEGER,
  ) {
    signal?.throwIfAborted();
    const video = videos.get(reference);
    if (!video) throw new BilibiliClientError("invalid_reference");
    if (
      !Number.isSafeInteger(maxDurationSeconds) ||
      maxDurationSeconds < 1 ||
      !video.downloadable ||
      !cookie ||
      video.duration <= 0 ||
      video.duration > maxDurationSeconds
    )
      throw new BilibiliClientError("api_rejected");
    const navigation = await api("/x/web-interface/nav", {}, signal);
    if (navigation.isLogin !== true) throw new BilibiliClientError("api_rejected");
    const wbi = object(navigation.wbi_img);
    const keyPart = (value: unknown) => {
      if (typeof value !== "string") return invalid();
      const match = /^https:\/\/i[0-2]\.hdslb\.com\/bfs\/wbi\/([a-f0-9]{32})\.(?:png|jpg)$/.exec(
        value,
      );
      return match?.[1] ?? invalid();
    };
    const keys = keyPart(wbi.img_url) + keyPart(wbi.sub_url);
    // WBI parameter signing, as implemented by the public Bilibili player and yt-dlp.
    const indices = [
      46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35, 27, 43, 5, 49, 33, 9, 42, 19, 29,
      28, 14, 39, 12, 38, 41, 13,
    ];
    const mixin = indices.map((index) => keys[index]).join("");
    const parameters: Record<string, string> = {
      bvid: video.bvid,
      cid: String(video.cid),
      fnval: "16",
      fourk: "0",
      qn: "16",
      wts: String(Math.round(Date.now() / 1000)),
    };
    const query = new URLSearchParams(
      Object.entries(parameters).sort(([left], [right]) => left.localeCompare(right)),
    ).toString();
    parameters.w_rid = createHash("md5")
      .update(query + mixin)
      .digest("hex");
    const data = await api("/x/player/wbi/playurl", parameters, signal);
    if (
      data.is_preview ||
      data.is_drm ||
      (data.drm_tech_type !== undefined && data.drm_tech_type !== 0)
    )
      throw new BilibiliClientError("api_rejected");
    const duration = integer(data.timelength, 1, Number.MAX_SAFE_INTEGER) / 1000;
    if (duration > maxDurationSeconds || Math.abs(duration - video.duration) > 2)
      throw new BilibiliClientError("api_rejected");
    const dash = object(data.dash);
    if (!Array.isArray(dash.audio) || !dash.audio.length || dash.audio.length > 20) invalid();
    const audio = dash.audio
      .map(object)
      .filter(
        (entry) =>
          (entry.mimeType ?? entry.mime_type) === "audio/mp4" &&
          typeof entry.codecs === "string" &&
          /^mp4a\.[0-9.]+$/.test(entry.codecs) &&
          !entry.drm_tech_type,
      )
      .map((entry) => ({ entry, bandwidth: integer(entry.bandwidth, 1, 1_000_000) }))
      .sort((left, right) => left.bandwidth - right.bandwidth)[0];
    if (!audio) throw new BilibiliClientError("api_rejected");
    const value = audio.entry.baseUrl ?? audio.entry.base_url;
    if (typeof value !== "string" || value.length > 4096 || /[\s\\]/u.test(value)) invalid();
    let url: URL;
    try {
      url = new URL(value);
    } catch {
      return invalid();
    }
    if (
      url.protocol !== "https:" ||
      url.username ||
      url.password ||
      url.port ||
      url.hash ||
      !/^[a-z0-9-]+\.(?:bilivideo\.com|bilivideo\.cn)$/.test(url.hostname)
    )
      invalid();
    signal?.throwIfAborted();
    return { url: url.href, allowedHosts: [url.hostname], durationSeconds: duration };
  }

  return { getVideo, listSubtitles, readSubtitle, getAudio };
}
