export const MAX_MEDIA_RESOURCE_ID = Number.MAX_SAFE_INTEGER;
export const MAX_BILIBILI_PART = 1_000;
export const MAX_MEDIA_LINK_LENGTH = 2_048;

export class MediaLinkParseError extends Error {
  readonly code = "invalid_media_link";

  constructor() {
    super("Invalid or unsupported media resource link");
    this.name = "MediaLinkParseError";
  }
}

export interface NeteaseCanonicalResource {
  kind: "canonical";
  platform: "netease";
  resourceType: "song" | "album" | "playlist";
  id: number;
  canonicalUrl: string;
}
export interface NeteaseShortLink {
  kind: "short_link";
  platform: "netease";
  url: string;
  needsResolution: true;
}
export type NeteaseResource = NeteaseCanonicalResource | NeteaseShortLink;

type BilibiliIdentifier = { idType: "bv"; id: string } | { idType: "av"; id: number };
export type BilibiliCanonicalResource = BilibiliIdentifier & {
  kind: "canonical";
  platform: "bilibili";
  resourceType: "video";
  part: number;
  canonicalUrl: string;
};
export interface BilibiliShortLink {
  kind: "short_link";
  platform: "bilibili";
  url: string;
  /** Omitted means the host must preserve any part selected by the resolved destination. */
  part?: number;
  needsResolution: true;
}
export type BilibiliResource = BilibiliCanonicalResource | BilibiliShortLink;

const NETEASE_HOSTS = new Set(["music.163.com", "y.music.163.com", "163cn.tv"]);
const BILIBILI_HOSTS = new Set(["bilibili.com", "www.bilibili.com", "m.bilibili.com", "b23.tv"]);
const NETEASE_PATH = /^\/(?:m\/)?(song|album|playlist)\/?$/;
const BILIBILI_BV = /^BV1[A-Za-z0-9]{9}$/;

function invalid(): never {
  throw new MediaLinkParseError();
}

function normalizedInput(input: string): string {
  if (typeof input !== "string" || input.length > MAX_MEDIA_LINK_LENGTH) invalid();
  // WHATWG URL otherwise silently removes tabs/newlines and treats backslashes as separators.
  for (const character of input) {
    const code = character.charCodeAt(0);
    if (code < 0x20 || code === 0x7f) invalid();
  }
  const value = input.trim();
  if (!value || /\s/.test(value) || value.includes("\\")) invalid();
  return value;
}

function strictUrl(value: string, hosts: ReadonlySet<string>): URL {
  const authority = /^https:\/\/([^/?#]+)(?:[/?#]|$)/i.exec(value)?.[1];
  if (!authority) invalid();
  // Require an ASCII whitelist authority before URL's IDNA/percent-decoding normalization.
  const host = /^([A-Za-z0-9.-]+)(?::443)?$/.exec(authority)?.[1]?.toLowerCase();
  if (!host || !hosts.has(host)) invalid();
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    invalid();
  }
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.port ||
    url.hostname !== host
  )
    invalid();
  const rawPath =
    value.slice(value.indexOf(authority) + authority.length).split(/[?#]/, 1)[0] || "/";
  if (rawPath !== url.pathname) invalid();
  uniqueIdentityParameters(url.searchParams);
  return url;
}

function uniqueIdentityParameters(parameters: URLSearchParams): void {
  for (const key of ["id", "p"]) {
    if (parameters.getAll(key).length > 1) invalid();
  }
}

function positiveInteger(value: string | null, maximum = MAX_MEDIA_RESOURCE_ID): number {
  if (value === null || !/^[0-9]{1,16}$/.test(value)) invalid();
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 1 || number > maximum) invalid();
  return number;
}

function shortToken(url: URL): string {
  if (url.hash || url.searchParams.has("id")) invalid();
  return /^\/([A-Za-z0-9_-]{1,128})\/?$/.exec(url.pathname)?.[1] ?? invalid();
}

function rejectCompetingFragment(url: URL): void {
  if (url.hash.startsWith("#/")) invalid();
  const parameters = new URLSearchParams(url.hash.slice(1).replace(/^\?/, ""));
  if (parameters.has("id") || parameters.has("p")) invalid();
}

/**
 * Parse one whole HTTPS link, never a URL embedded in share text. This performs no I/O.
 * Netease's web/mobile/hash spellings are observed share-link formats, not an API contract:
 * https://github.com/Changhuaishui/netease-playlist-doctor/blob/main/references/api-endpoints.md
 * https://github.com/xuanlove/Netease_php_url#-支持的链接格式
 * Official pages were not externally accessible during verification; resource availability is unverified.
 */
export function parseNeteaseResource(input: string): NeteaseResource {
  const url = strictUrl(normalizedInput(input), NETEASE_HOSTS);
  if (url.hostname === "163cn.tv") {
    if (url.searchParams.has("p")) invalid();
    const token = shortToken(url);
    return {
      kind: "short_link",
      platform: "netease",
      url: `https://163cn.tv/${token}`,
      needsResolution: true,
    };
  }
  let path = url.pathname;
  let parameters = url.searchParams;
  if (url.hash.startsWith("#/")) {
    if (path !== "/" || parameters.has("id") || url.hash.slice(1).includes("#")) invalid();
    const route = url.hash.slice(1);
    const separator = route.indexOf("?");
    if (separator < 0) invalid();
    path = route.slice(0, separator);
    parameters = new URLSearchParams(route.slice(separator + 1));
    uniqueIdentityParameters(parameters);
  } else {
    rejectCompetingFragment(url);
  }
  const resourceType = NETEASE_PATH.exec(path)?.[1];
  if (resourceType !== "song" && resourceType !== "album" && resourceType !== "playlist") invalid();
  const id = positiveInteger(parameters.get("id"));
  return {
    kind: "canonical",
    platform: "netease",
    resourceType,
    id,
    canonicalUrl: `https://music.163.com/${resourceType}?id=${id}`,
  };
}

function bilibiliIdentifier(value: string): BilibiliIdentifier {
  if (BILIBILI_BV.test(value)) return { idType: "bv", id: value };
  const av = /^av([0-9]+)$/i.exec(value)?.[1];
  if (av !== undefined) return { idType: "av", id: positiveInteger(av) };
  return invalid();
}

function bilibiliCanonical(
  identifier: BilibiliIdentifier,
  part: number,
): BilibiliCanonicalResource {
  const video = identifier.idType === "av" ? `av${identifier.id}` : identifier.id;
  return {
    kind: "canonical",
    platform: "bilibili",
    resourceType: "video",
    ...identifier,
    part,
    canonicalUrl: `https://www.bilibili.com/video/${video}${part === 1 ? "" : `?p=${part}`}`,
  };
}

/**
 * Accept a whole BV/av identifier or one HTTPS video/share URL. BV identifiers retain their case.
 * Official player docs establish bvid/aid and one-based p: https://player.bilibili.com/player/?bvid=1Xm421579d
 * A platform-hosted b23.tv example: https://www.bilibili.com/video/BV1z8411D7yS/
 * The 1000-part cap is a local request bound, not an availability or platform-limit claim.
 * Short links need an authorized host resolver that revalidates every redirect; this module never follows them.
 */
export function parseBilibiliResource(input: string): BilibiliResource {
  const value = normalizedInput(input);
  if (BILIBILI_BV.test(value) || /^av[0-9]+$/i.test(value))
    return bilibiliCanonical(bilibiliIdentifier(value), 1);
  const url = strictUrl(value, BILIBILI_HOSTS);
  const part = url.searchParams.has("p")
    ? positiveInteger(url.searchParams.get("p"), MAX_BILIBILI_PART)
    : undefined;
  if (url.hostname === "b23.tv") {
    const token = shortToken(url);
    return {
      kind: "short_link",
      platform: "bilibili",
      url: `https://b23.tv/${token}${part === undefined ? "" : `?p=${part}`}`,
      ...(part === undefined ? {} : { part }),
      needsResolution: true,
    };
  }
  rejectCompetingFragment(url);
  const identifier = /^\/video\/([^/]+)\/?$/.exec(url.pathname)?.[1];
  if (!identifier) invalid();
  return bilibiliCanonical(bilibiliIdentifier(identifier), part ?? 1);
}
