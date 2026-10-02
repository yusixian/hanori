import { randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { open } from "node:fs/promises";
import type { TranscriptDocument } from "@cos-tool-bot/shared";
import { MediaHttpError, sendMediaDocument } from "./http.js";

export type AsrFailure =
  | "invalid_configuration"
  | "invalid_file"
  | "invalid_response"
  | "timing_unavailable"
  | "forbidden"
  | "rate_limited"
  | "unavailable"
  | "upstream_error"
  | "too_large"
  | "timeout"
  | "cancelled";

export class AsrClientError extends Error {
  constructor(readonly code: AsrFailure) {
    super(`ASR failed: ${code}`);
    this.name = "AsrClientError";
  }
}

export interface AsrConfiguration {
  baseUrl: string;
  apiKey: string;
  model: string;
  language?: string;
}

const MAX_WAV_BYTES = 20 * 1024 * 1024;
const LANGUAGE = /^[A-Za-z0-9-]{1,64}$/;

function invalid(code: AsrFailure = "invalid_response"): never {
  throw new AsrClientError(code);
}

function providerUrl(value: string): URL {
  try {
    if (typeof value !== "string" || value.length > 2048 || /[\s\\?#]/.test(value))
      invalid("invalid_configuration");
    const authority = /^https:\/\/([A-Za-z0-9.-]+)(?:\/|$)/.exec(value)?.[1];
    if (!authority || !/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/i.test(authority))
      invalid("invalid_configuration");
    const url = new URL(value);
    if (
      url.protocol !== "https:" ||
      url.port ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      url.hostname !== authority.toLowerCase()
    )
      invalid("invalid_configuration");
    const rawPath = value.slice(value.indexOf(authority) + authority.length) || "/";
    if (rawPath !== url.pathname) invalid("invalid_configuration");
    url.pathname = `${url.pathname.replace(/\/$/, "")}/audio/transcriptions`;
    return url;
  } catch {
    return invalid("invalid_configuration");
  }
}

export async function readAsrWav(path: string, signal: AbortSignal): Promise<Buffer> {
  signal.throwIfAborted();
  let file;
  try {
    file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const stat = await file.stat();
    if (!stat.isFile() || stat.nlink !== 1 || stat.size < 44) invalid("invalid_file");
    if (stat.size > MAX_WAV_BYTES) invalid("too_large");
    const bytes = Buffer.alloc(stat.size);
    let offset = 0;
    while (offset < bytes.length) {
      signal.throwIfAborted();
      const read = await file.read(bytes, offset, bytes.length - offset, offset);
      if (!read.bytesRead) invalid("invalid_file");
      offset += read.bytesRead;
    }
    signal.throwIfAborted();
    const after = await file.stat();
    if (
      after.size !== stat.size ||
      after.nlink !== 1 ||
      after.mtimeMs !== stat.mtimeMs ||
      after.ctimeMs !== stat.ctimeMs ||
      !bytes.subarray(0, 4).equals(Buffer.from("RIFF")) ||
      !bytes.subarray(8, 12).equals(Buffer.from("WAVE")) ||
      bytes.readUInt32LE(4) + 8 !== bytes.length
    )
      invalid("invalid_file");
    return bytes;
  } catch (error) {
    signal.throwIfAborted();
    if (error instanceof AsrClientError) throw error;
    return invalid("invalid_file");
  } finally {
    await file?.close().catch(() => undefined);
  }
}

function transcript(bytes: Buffer, configuredLanguage?: string): TranscriptDocument {
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    return invalid();
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid();
  const data = value as Record<string, unknown>;
  if (data.segments === undefined) invalid("timing_unavailable");
  if (!Array.isArray(data.segments) || data.segments.length > 10_000) invalid();
  if (
    data.duration !== undefined &&
    (typeof data.duration !== "number" ||
      !Number.isFinite(data.duration) ||
      data.duration < 0 ||
      data.duration > 600)
  )
    invalid();
  const language = data.language ?? configuredLanguage ?? null;
  if (language !== null && (typeof language !== "string" || !LANGUAGE.test(language))) invalid();
  let previousStart = -1;
  let previousEnd = -1;
  let textChars = 0;
  const cues = data.segments.map((raw) => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) invalid();
    const segment = raw as Record<string, unknown>;
    if (
      typeof segment.start !== "number" ||
      typeof segment.end !== "number" ||
      !Number.isFinite(segment.start) ||
      !Number.isFinite(segment.end) ||
      segment.start < 0 ||
      segment.end <= segment.start ||
      segment.end > 600 ||
      typeof segment.text !== "string" ||
      segment.text.length > 16_384
    )
      invalid();
    const startMs = Math.round(segment.start * 1000);
    const endMs = Math.round(segment.end * 1000);
    if (startMs < previousStart || endMs < previousEnd || endMs <= startMs) invalid();
    previousStart = startMs;
    previousEnd = endMs;
    textChars += segment.text.length;
    if (textChars > 500_000) invalid();
    for (const key of ["avg_logprob", "no_speech_prob"]) {
      if (
        segment[key] !== undefined &&
        (typeof segment[key] !== "number" || !Number.isFinite(segment[key]))
      )
        invalid();
    }
    if (segment.avg_logprob !== undefined && (segment.avg_logprob as number) > 0) invalid();
    if (
      segment.no_speech_prob !== undefined &&
      ((segment.no_speech_prob as number) < 0 || (segment.no_speech_prob as number) > 1)
    )
      invalid();
    // Official verbose_json semantics identify avg_logprob < -1 as failed confidence.
    // no_speech_prob alone does not establish recognition uncertainty or speaker identity.
    const uncertain = typeof segment.avg_logprob === "number" && segment.avg_logprob < -1;
    return { startMs, endMs, text: segment.text, ...(uncertain ? { uncertain: true } : {}) };
  });
  if (!cues.length && typeof data.text === "string" && data.text.trim())
    invalid("timing_unavailable");
  return { source: "asr", track: "original", language: language as string | null, cues };
}

/** OpenAI-compatible multipart transcription with segment timestamps:
 * https://developers.openai.com/api/reference/resources/audio/subresources/transcriptions/methods/create
 * The configured model must support verbose_json + segment timestamps. No model/provider fallback.
 */
export function createAsrClient(config: AsrConfiguration) {
  const url = providerUrl(config.baseUrl);
  if (
    typeof config.apiKey !== "string" ||
    !/^[!-~]{1,4096}$/.test(config.apiKey) ||
    typeof config.model !== "string" ||
    !/^[A-Za-z0-9_.-]{1,64}$/.test(config.model) ||
    (config.language !== undefined &&
      (typeof config.language !== "string" || !LANGUAGE.test(config.language)))
  )
    invalid("invalid_configuration");
  const { apiKey, model, language } = config;

  async function transcribeInput(
    source: string | Buffer,
    callSignal?: AbortSignal,
  ): Promise<TranscriptDocument> {
    const deadline = new AbortController();
    const timer = setTimeout(() => deadline.abort(new AsrClientError("timeout")), 180_000);
    timer.unref();
    const signal = callSignal ? AbortSignal.any([callSignal, deadline.signal]) : deadline.signal;
    try {
      signal.throwIfAborted();
      if (typeof source !== "string" && source.length > MAX_WAV_BYTES) invalid("too_large");
      const wav =
        typeof source === "string" ? await readAsrWav(source, signal) : Buffer.from(source);
      if (
        wav.length < 44 ||
        wav.length > MAX_WAV_BYTES ||
        !wav.subarray(0, 4).equals(Buffer.from("RIFF")) ||
        !wav.subarray(8, 12).equals(Buffer.from("WAVE")) ||
        wav.readUInt32LE(4) + 8 !== wav.length
      )
        invalid("invalid_file");
      const boundary = `hanori_${randomBytes(16).toString("hex")}`;
      const fields = {
        model,
        response_format: "verbose_json",
        "timestamp_granularities[]": "segment",
        ...(language ? { language } : {}),
      };
      const prefix =
        Object.entries(fields)
          .map(
            ([name, value]) =>
              `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`,
          )
          .join("") +
        `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="audio.wav"\r\nContent-Type: audio/wav\r\n\r\n`;
      const body = Buffer.concat([
        Buffer.from(prefix),
        wav,
        Buffer.from(`\r\n--${boundary}--\r\n`),
      ]);
      signal.throwIfAborted();
      const response = await sendMediaDocument(
        url.href,
        {
          allowedHosts: [url.hostname],
          mimeTypes: ["application/json"],
          maxBytes: 2 * 1024 * 1024,
          timeoutMs: 180_000,
          credential: { origin: url.origin, authorization: `Bearer ${apiKey}` },
          signal,
        },
        { bytes: body, contentType: `multipart/form-data; boundary=${boundary}` },
      );
      signal.throwIfAborted();
      return transcript(response.bytes, language);
    } catch (error) {
      if (callSignal?.aborted) throw new AsrClientError("cancelled");
      if (deadline.signal.aborted) throw new AsrClientError("timeout");
      if (error instanceof AsrClientError) throw error;
      if (error instanceof MediaHttpError) {
        const code =
          error.code === "invalid_content"
            ? "invalid_response"
            : error.code === "invalid_request"
              ? "invalid_configuration"
              : error.code;
        throw new AsrClientError(code);
      }
      throw new AsrClientError("upstream_error");
    } finally {
      clearTimeout(timer);
    }
  }
  return {
    transcribe: (path: string, signal?: AbortSignal) => transcribeInput(path, signal),
    transcribeBytes: (wav: Buffer, signal?: AbortSignal) => transcribeInput(wav, signal),
  };
}
