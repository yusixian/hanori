import { createHash } from "node:crypto";
import {
  DEFAULT_NSFW_THRESHOLD,
  type ImageSafetyResult,
  type NsfwScores,
} from "@cos-tool-bot/shared";
import sharp from "sharp";
import { isWebpageUrlBlocked } from "../tools/web.js";

export type { NsfwScores };
export type NsfwCheckResult = ImageSafetyResult;
export type NsfwLogger = (
  level: "warn" | "error" | "debug",
  message: string,
  meta?: Record<string, unknown>,
) => void;
export interface NsfwCheckerConfig {
  apiUrl: string;
  threshold?: number;
  timeoutMs?: number;
  logger?: NsfwLogger;
}
export const MAX_NSFW_IMAGE_BYTES = 20 * 1024 * 1024;
const CACHE_TTL_MS = 5 * 60_000;
const SCORE_KEYS = ["porn", "sexy", "hentai", "neutral", "drawing"] as const;

export function unknownImageSafety(status: "failed" | "unavailable" = "failed"): NsfwCheckResult {
  return { status, isNsfw: true, scores: null };
}
export function needsImageSpoiler(
  result: NsfwCheckResult,
  threshold = DEFAULT_NSFW_THRESHOLD,
): boolean {
  return (
    !result.scores || result.scores.porn + result.scores.hentai + result.scores.sexy >= threshold
  );
}
export async function readBoundedImage(
  response: Response,
  maxBytes = MAX_NSFW_IMAGE_BYTES,
): Promise<Uint8Array> {
  if (!response.ok) throw new Error(`Image download failed: HTTP ${response.status}`);
  if (Number(response.headers.get("content-length")) > maxBytes) {
    await response.body?.cancel();
    throw new Error("NSFW response exceeds size limit");
  }
  if (!response.body) throw new Error("Image response has no body");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) throw new Error("NSFW response exceeds size limit");
      chunks.push(value);
    }
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
  return Buffer.concat(chunks, size);
}

export class NsfwChecker {
  private readonly apiUrl: string;
  private readonly threshold: number;
  private readonly timeoutMs: number;
  private readonly log: NsfwLogger;
  private readonly cache = new Map<string, { expiresAt: number; result: NsfwCheckResult }>();
  constructor(config: NsfwCheckerConfig) {
    this.apiUrl = config.apiUrl.replace(/\/+$/, "");
    this.threshold = config.threshold ?? DEFAULT_NSFW_THRESHOLD;
    this.timeoutMs = config.timeoutMs ?? 10_000;
    this.log = config.logger ?? (() => {});
  }
  async openImageUrl(url: string, signal?: AbortSignal): Promise<Response> {
    const deadline = signal ?? this.deadline();
    let current = new URL(url);
    for (let redirects = 0; redirects <= 3; redirects++) {
      if (current.username || current.password || isWebpageUrlBlocked(current.href)) {
        throw new Error("Image URL is not allowed for NSFW detection");
      }
      const response = await fetch(current, { signal: deadline, redirect: "manual" });
      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get("location");
        await response.body?.cancel();
        if (!location || redirects === 3) throw new Error("Invalid image redirect");
        current = new URL(location, current);
        continue;
      }
      if (!response.ok || !response.body) {
        await response.body?.cancel();
        throw new Error(`Image download failed: HTTP ${response.status}`);
      }
      return response;
    }
    throw new Error("Too many image redirects");
  }
  async readImageUrl(url: string, signal?: AbortSignal): Promise<Uint8Array> {
    return readBoundedImage(await this.openImageUrl(url, this.deadline(signal)));
  }
  async checkImageUrl(url: string, signal?: AbortSignal): Promise<NsfwCheckResult> {
    try {
      return await this.checkImageBytes(await this.readImageUrl(url, signal), signal);
    } catch {
      signal?.throwIfAborted();
      this.log("warn", "NSFW image download failed; applying spoiler");
      return unknownImageSafety();
    }
  }
  async checkImageBytes(bytes: Uint8Array, signal?: AbortSignal): Promise<NsfwCheckResult> {
    try {
      signal?.throwIfAborted();
      if (bytes.byteLength === 0 || bytes.byteLength > MAX_NSFW_IMAGE_BYTES)
        throw new Error("Invalid NSFW image size");
      const key = createHash("sha256").update(bytes).digest("hex");
      const cached = this.cache.get(key);
      if (cached && cached.expiresAt > Date.now()) return cached.result;
      // Normalize actual bytes, independent of unreliable Content-Type headers.
      const jpeg = await sharp(bytes, { limitInputPixels: 40_000_000 })
        .rotate()
        .resize({
          width: 1024,
          height: 1024,
          fit: "inside",
          withoutEnlargement: true,
        })
        .jpeg()
        .toBuffer();
      signal?.throwIfAborted();
      const form = new FormData();
      form.append("image", new Blob([new Uint8Array(jpeg)], { type: "image/jpeg" }), "image.jpg");
      const response = await fetch(`${this.apiUrl}/classify`, {
        method: "POST",
        body: form,
        signal: this.deadline(signal),
      });
      if (!response.ok) {
        await response.body?.cancel();
        throw new Error(`Classifier returned HTTP ${response.status}`);
      }
      const body = await readBoundedImage(response, 16_384);
      const value: unknown = JSON.parse(Buffer.from(body).toString("utf8"));
      if (
        !value ||
        typeof value !== "object" ||
        !SCORE_KEYS.every((key) => {
          const score = (value as Record<string, unknown>)[key];
          return typeof score === "number" && Number.isFinite(score) && score >= 0 && score <= 1;
        })
      )
        throw new Error("Invalid classifier scores");
      const scores = Object.fromEntries(
        SCORE_KEYS.map((key) => [key, (value as Record<string, number>)[key]]),
      ) as unknown as NsfwScores;
      const result: NsfwCheckResult = {
        status: "checked",
        scores,
        isNsfw: scores.porn + scores.hentai + scores.sexy >= this.threshold,
      };
      this.cache.delete(key);
      if (this.cache.size >= 128) this.cache.delete(this.cache.keys().next().value!);
      this.cache.set(key, { expiresAt: Date.now() + CACHE_TTL_MS, result });
      this.log("debug", "NSFW image classified", { scores, isNsfw: result.isNsfw });
      return result;
    } catch {
      signal?.throwIfAborted();
      this.log("warn", "NSFW classification failed; applying spoiler");
      return unknownImageSafety();
    }
  }
  async checkImageUrls(
    urls: string[],
  ): Promise<{ isNsfw: boolean; scores: NsfwScores[] | undefined }> {
    const results = await Promise.all(urls.map((url) => this.checkImageUrl(url)));
    return {
      isNsfw: results.some((result) => result.isNsfw),
      scores: results.every((result) => result.scores)
        ? results.map((result) => result.scores!)
        : undefined,
    };
  }
  private deadline(signal?: AbortSignal): AbortSignal {
    const timeout = AbortSignal.timeout(this.timeoutMs);
    return signal ? AbortSignal.any([signal, timeout]) : timeout;
  }
}
