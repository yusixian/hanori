import { DEFAULT_NSFW_THRESHOLD } from "@cos-tool-bot/shared";
import type { NsfwScores } from "@cos-tool-bot/shared";
import sharp from "sharp";

export type { NsfwScores };

export interface NsfwCheckResult {
  isNsfw: boolean;
  scores: NsfwScores;
}

export type NsfwLogger = (
  level: "warn" | "error" | "debug",
  message: string,
  meta?: Record<string, unknown>,
) => void;

export interface NsfwCheckerConfig {
  apiUrl: string;
  threshold?: number; // default 0.5
  timeoutMs?: number; // default 10000
  logger?: NsfwLogger;
}

const DEFAULT_THRESHOLD = DEFAULT_NSFW_THRESHOLD;
const DEFAULT_TIMEOUT_MS = 10_000;
const SUPPORTED_TYPES = new Set(["image/bmp", "image/jpeg", "image/png", "image/gif"]);

function failOpen(): NsfwCheckResult {
  return {
    isNsfw: false,
    scores: { porn: 0, sexy: 0, hentai: 0, neutral: 1, drawing: 0 },
  };
}

export class NsfwChecker {
  private apiUrl: string;
  private threshold: number;
  private timeoutMs: number;
  private log: NsfwLogger;

  constructor(config: NsfwCheckerConfig) {
    this.apiUrl = config.apiUrl.replace(/\/+$/, "");
    this.threshold = config.threshold ?? DEFAULT_THRESHOLD;
    this.timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.log = config.logger ?? (() => {});
    this.log("debug", `NsfwChecker initialized`, {
      apiUrl: this.apiUrl,
      threshold: this.threshold,
    });
  }

  async checkImageUrl(url: string): Promise<NsfwCheckResult> {
    try {
      const imgRes = await fetch(url, { signal: AbortSignal.timeout(this.timeoutMs) });
      if (!imgRes.ok) {
        this.log("warn", `Image fetch failed: ${imgRes.status} ${imgRes.statusText}`, { url });
        return failOpen();
      }

      const blob = await imgRes.blob();
      this.log("debug", `Image fetched: ${blob.size} bytes, type=${blob.type}`, { url });

      let buffer: Uint8Array = new Uint8Array(await blob.arrayBuffer());
      const contentType = blob.type;

      if (contentType && !SUPPORTED_TYPES.has(contentType)) {
        this.log("debug", `Converting ${contentType} to JPEG for NSFW check`);
        buffer = await sharp(buffer).jpeg().toBuffer();
      }

      const form = new FormData();
      const imageBlob = new Blob([buffer.buffer as ArrayBuffer], { type: "image/jpeg" });
      form.append("image", imageBlob, "image.jpg");

      const classifyRes = await fetch(`${this.apiUrl}/classify`, {
        method: "POST",
        body: form,
        signal: AbortSignal.timeout(this.timeoutMs),
      });
      if (!classifyRes.ok) {
        const body = await classifyRes.text().catch(() => "");
        this.log("warn", `Classify API failed: ${classifyRes.status}`, {
          apiUrl: this.apiUrl,
          body,
        });
        return failOpen();
      }

      const scores = (await classifyRes.json()) as NsfwScores;
      const nsfwScore = (scores.porn ?? 0) + (scores.hentai ?? 0) + (scores.sexy ?? 0);
      this.log("debug", `NSFW scores`, { scores, nsfwScore, threshold: this.threshold });

      return {
        isNsfw: nsfwScore >= this.threshold,
        scores,
      };
    } catch (err) {
      this.log("error", `NSFW check error: ${err instanceof Error ? err.message : String(err)}`);
      return failOpen();
    }
  }

  async checkImageUrls(urls: string[]): Promise<{ isNsfw: boolean; scores: NsfwScores[] }> {
    const results = await Promise.all(urls.map((url) => this.checkImageUrl(url)));
    return {
      isNsfw: results.some((r) => r.isNsfw),
      scores: results.map((r) => r.scores),
    };
  }
}
