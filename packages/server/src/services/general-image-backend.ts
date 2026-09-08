import { isIP } from "node:net";
import { lookup } from "node:dns/promises";
import type { IncomingMessage } from "node:http";
import { request as httpsRequest } from "node:https";
import type { Database } from "@cos-tool-bot/database";
import { bots } from "@cos-tool-bot/database";
import { eq } from "drizzle-orm";
import type { GeneralImageBackend } from "./image-generation-service.js";

const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
const REQUEST_TIMEOUT_MS = 5 * 60_000;
const ALLOWED_IMAGE_MIME_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);

export class BotConfiguredGeneralImageBackend implements GeneralImageBackend {
  constructor(private readonly db: Database) {}

  async isConfigured(botId: string): Promise<boolean> {
    return (await this.getConfiguredImageGeneration(botId)) !== null;
  }

  async create(input: {
    botId: string;
    prompt: string;
    presetKey?: string;
    negativePrompt?: string;
    seed?: number;
    signal?: AbortSignal;
  }) {
    const config = await this.getConfiguredImageGeneration(input.botId);
    if (!config) {
      throw new Error("General image backend is not configured");
    }
    const baseURL = new URL(config.baseURL || "https://api.openai.com/v1");
    if (
      baseURL.protocol !== "https:" &&
      baseURL.hostname !== "127.0.0.1" &&
      baseURL.hostname !== "localhost"
    ) {
      throw new Error("General image backend must use HTTPS");
    }
    const endpoint = new URL(`${baseURL.pathname.replace(/\/+$/, "")}/images/generations`, baseURL);
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (config.apiKey) headers["Authorization"] = `Bearer ${config.apiKey}`;
    const signal = input.signal
      ? AbortSignal.any([input.signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)])
      : AbortSignal.timeout(REQUEST_TIMEOUT_MS);
    const response = await fetch(endpoint, {
      method: "POST",
      headers,
      body: JSON.stringify({
        model: config.model || "dall-e-3",
        prompt: input.prompt,
        n: 1,
        size: config.size || "1024x1024",
        response_format: "b64_json",
      }),
      signal,
    });
    if (!response.ok) throw new Error(`General image backend failed with HTTP ${response.status}`);
    const body = (await response.json()) as {
      data?: Array<{ b64_json?: string; url?: string }>;
    };
    const first = body.data?.[0];
    if (!first) throw new Error("General image backend returned no artifact");
    if (first.b64_json) {
      if (!isCanonicalBase64(first.b64_json)) {
        throw new Error("General image artifact is not valid base64");
      }
      const bytes = Buffer.from(first.b64_json, "base64");
      if (bytes.byteLength === 0 || bytes.byteLength > MAX_IMAGE_BYTES) {
        throw new Error("General image artifact has an invalid size");
      }
      const mimeType = detectMime(bytes);
      if (!mimeType) throw new Error("General image artifact is not a supported image");
      return [{ bytes, mimeType, source: "inline" as const }];
    }
    if (!first.url) throw new Error("General image backend returned no supported artifact");
    return [await downloadPublicImage(first.url, signal)];
  }

  private async getConfiguredImageGeneration(botId: string) {
    const [bot] = await this.db
      .select({ aiConfig: bots.aiConfig })
      .from(bots)
      .where(eq(bots.id, botId))
      .limit(1);
    const config = bot?.aiConfig?.webToolsConfig?.imageGeneration;
    return !config || config.provider === "pixai" ? null : config;
  }
}

async function downloadPublicImage(value: string, signal: AbortSignal) {
  let url = new URL(value);
  for (let redirect = 0; redirect <= 3; redirect += 1) {
    const address = await resolvePublicHttpsUrl(url);
    const response = await requestPinned(url, address, signal);
    const status = response.statusCode ?? 500;
    if (status >= 300 && status < 400) {
      const location = response.headers.location;
      response.resume();
      if (!location) throw new Error("General image redirect is invalid");
      url = new URL(location, url);
      continue;
    }
    if (status < 200 || status >= 300) {
      response.resume();
      throw new Error(`General image download failed with HTTP ${status}`);
    }
    const mimeType = response.headers["content-type"]?.split(";", 1)[0]?.trim().toLowerCase();
    if (!mimeType || !ALLOWED_IMAGE_MIME_TYPES.has(mimeType)) {
      response.resume();
      throw new Error("General image artifact is not a supported image");
    }
    const contentLength = response.headers["content-length"];
    if (contentLength !== undefined) {
      const declaredLength = Number(contentLength);
      if (!Number.isSafeInteger(declaredLength) || declaredLength < 0) {
        response.resume();
        throw new Error("General image artifact has an invalid content length");
      }
      if (declaredLength > MAX_IMAGE_BYTES) {
        response.resume();
        throw new Error("General image artifact is too large");
      }
    }
    const bytes = await readBoundedResponse(response, MAX_IMAGE_BYTES);
    if (bytes.byteLength === 0 || bytes.byteLength > MAX_IMAGE_BYTES) {
      throw new Error("General image artifact has an invalid size");
    }
    if (detectMime(bytes) !== mimeType) {
      throw new Error("General image artifact content does not match its MIME type");
    }
    return { bytes, mimeType, source: "resource_link" as const };
  }
  throw new Error("General image redirected too many times");
}

async function resolvePublicHttpsUrl(url: URL): Promise<string> {
  if (url.protocol !== "https:" || url.username || url.password) {
    throw new Error("General image artifact URL is not allowed");
  }
  const addresses = await lookup(url.hostname, { all: true, verbatim: true });
  if (addresses.length === 0 || addresses.some(({ address }) => isPrivateAddress(address))) {
    throw new Error("General image artifact URL resolves to a private address");
  }
  return addresses[0]!.address;
}

function requestPinned(url: URL, address: string, signal: AbortSignal): Promise<IncomingMessage> {
  return new Promise((resolve, reject) => {
    const request = httpsRequest(
      {
        protocol: "https:",
        hostname: address,
        port: url.port || 443,
        path: `${url.pathname}${url.search}`,
        method: "GET",
        headers: { Host: url.host },
        servername: isIP(url.hostname) === 0 ? url.hostname : undefined,
        signal,
      },
      resolve,
    );
    request.once("error", reject);
    request.end();
  });
}

async function readBoundedResponse(response: IncomingMessage, maxBytes: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const value of response) {
    const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value as Uint8Array);
    total += chunk.byteLength;
    if (total > maxBytes) {
      response.destroy(new Error("General image artifact is too large"));
      throw new Error("General image artifact is too large");
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks, total);
}

function isPrivateAddress(address: string): boolean {
  if (isIP(address) === 4) {
    const [a = 0, b = 0] = address.split(".").map(Number);
    return (
      a === 0 ||
      a === 10 ||
      a === 127 ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      a >= 224
    );
  }
  const normalized = address.toLowerCase();
  const dottedMapped = normalized.match(/^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/)?.[1];
  const hexMapped = normalized.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
  const mapped =
    dottedMapped ??
    (hexMapped
      ? [
          Number.parseInt(hexMapped[1]!, 16) >> 8,
          Number.parseInt(hexMapped[1]!, 16) & 0xff,
          Number.parseInt(hexMapped[2]!, 16) >> 8,
          Number.parseInt(hexMapped[2]!, 16) & 0xff,
        ].join(".")
      : undefined);
  if (mapped) return isPrivateAddress(mapped);
  return (
    normalized === "::" ||
    normalized === "::1" ||
    normalized.startsWith("fc") ||
    normalized.startsWith("fd") ||
    normalized.startsWith("fe8") ||
    normalized.startsWith("fe9") ||
    normalized.startsWith("fea") ||
    normalized.startsWith("feb") ||
    normalized.startsWith("ff")
  );
}

function detectMime(bytes: Buffer): string | undefined {
  if (bytes[0] === 0xff && bytes[1] === 0xd8) return "image/jpeg";
  if (
    bytes.subarray(0, 4).toString("ascii") === "RIFF" &&
    bytes.subarray(8, 12).toString("ascii") === "WEBP"
  ) {
    return "image/webp";
  }
  if (bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return "image/png";
  }
  return undefined;
}

function isCanonicalBase64(value: string): boolean {
  return (
    value.length > 0 &&
    value.length % 4 === 0 &&
    /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)
  );
}
