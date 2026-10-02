import {
  MediaLinkParseError,
  parseBilibiliResource,
  parseNeteaseResource,
  type BilibiliCanonicalResource,
  type NeteaseCanonicalResource,
} from "@cos-tool-bot/shared";
import { resolveMediaUrl } from "./http.js";

/** Resolves identity only; the platform client must still check access and availability. */
export async function resolveNeteaseResource(
  input: string,
  signal?: AbortSignal,
): Promise<NeteaseCanonicalResource> {
  signal?.throwIfAborted();
  const resource = parseNeteaseResource(input);
  if (resource.kind === "canonical") return resource;
  const destination = await resolveMediaUrl(resource.url, {
    allowedHosts: ["163cn.tv", "music.163.com", "y.music.163.com"],
    signal,
  });
  signal?.throwIfAborted();
  const resolved = parseNeteaseResource(destination);
  if (resolved.kind !== "canonical") throw new MediaLinkParseError();
  return resolved;
}

/** Short-link requests are credential-free, even when the later platform API uses a Cookie. */
export async function resolveBilibiliResource(
  input: string,
  signal?: AbortSignal,
): Promise<BilibiliCanonicalResource> {
  signal?.throwIfAborted();
  const resource = parseBilibiliResource(input);
  if (resource.kind === "canonical") return resource;
  const destination = await resolveMediaUrl(resource.url, {
    allowedHosts: ["b23.tv", "bilibili.com", "www.bilibili.com", "m.bilibili.com"],
    signal,
  });
  signal?.throwIfAborted();
  let resolved = parseBilibiliResource(destination);
  if (resolved.kind !== "canonical") throw new MediaLinkParseError();
  if (resource.part !== undefined) {
    const url = new URL(resolved.canonicalUrl);
    url.searchParams.set("p", String(resource.part));
    resolved = parseBilibiliResource(url.href);
    if (resolved.kind !== "canonical") throw new MediaLinkParseError();
  }
  return resolved;
}
