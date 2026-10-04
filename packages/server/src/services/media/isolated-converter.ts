import { request } from "node:http";
import { isAbsolute } from "node:path";
import {
  ASR_CONVERSION_TIMEOUT_MS,
  MAX_ASR_DURATION_SECONDS,
  MAX_ASR_WAV_BYTES,
} from "./long-audio.js";

export class MediaConversionError extends Error {
  constructor(
    readonly code: "converter_unavailable" | "conversion_failed" | "conversion_cancelled",
  ) {
    super(code);
    this.name = "MediaConversionError";
  }
}

class WorkerBusyError extends Error {}

function waitForWorker(milliseconds: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const abort = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
      reject(new MediaConversionError("conversion_cancelled"));
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", abort);
      resolve();
    }, milliseconds);
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
  });
}

/** Connects only to a host-configured Unix socket; never sends URLs or provider credentials. */
export class IsolatedAudioConverter {
  private busy = false;
  private waiting: Array<() => void> = [];

  private async withSlot<T>(signal: AbortSignal, operation: () => Promise<T>): Promise<T> {
    if (signal.aborted) throw new MediaConversionError("conversion_cancelled");
    await new Promise<void>((resolve, reject) => {
      const grant = () => {
        signal.removeEventListener("abort", abort);
        this.busy = true;
        resolve();
      };
      const abort = () => {
        const index = this.waiting.indexOf(grant);
        if (index >= 0) this.waiting.splice(index, 1);
        signal.removeEventListener("abort", abort);
        reject(new MediaConversionError("conversion_cancelled"));
      };
      if (this.busy) {
        this.waiting.push(grant);
        signal.addEventListener("abort", abort, { once: true });
      } else grant();
    });
    try {
      return await operation();
    } finally {
      const next = this.waiting.shift();
      if (next) next();
      else this.busy = false;
    }
  }

  private runJob(id: string, action: string, body: unknown, signal: AbortSignal) {
    return this.withSlot(signal, async () => {
      const timeout = action === "convert" ? ASR_CONVERSION_TIMEOUT_MS + 10_000 : 130_000;
      const waitDeadline = Date.now() + ASR_CONVERSION_TIMEOUT_MS + 30_000;
      for (;;) {
        if (signal.aborted) throw new MediaConversionError("conversion_cancelled");
        try {
          return await this.call("POST", `/jobs/${id}/${action}`, body, signal, timeout);
        } catch (error) {
          if (!(error instanceof WorkerBusyError)) {
            // A disconnected request can leave FFmpeg alive briefly; wait for worker cleanup
            // before admitting another local job. Cancellation itself bypasses the FIFO.
            await this.cancel(id).catch(() => undefined);
            throw error;
          }
        }
        // Other server processes have their own FIFO. Only this explicit worker rejection proves
        // our job was never accepted, so it is safe to wait/retry without cancelling its active job.
        const remaining = waitDeadline - Date.now();
        if (remaining <= 0) throw new MediaConversionError("conversion_failed");
        await waitForWorker(Math.min(500, remaining), signal);
        if (Date.now() >= waitDeadline) throw new MediaConversionError("conversion_failed");
      }
    });
  }

  constructor(
    private readonly socketPath: string,
    private readonly secret: string,
  ) {
    if (!isAbsolute(socketPath) || !/^[A-Za-z0-9_+/=-]{32,256}$/.test(secret))
      throw new MediaConversionError("converter_unavailable");
  }

  private async call(
    method: string,
    path: string,
    body?: unknown,
    signal?: AbortSignal,
    timeout = 5000,
  ): Promise<unknown> {
    const combined = AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(timeout)]);
    const serialized = body === undefined ? undefined : JSON.stringify(body);
    try {
      return await new Promise((resolve, reject) => {
        const req = request(
          {
            socketPath: this.socketPath,
            path,
            method,
            signal: combined,
            headers: {
              Authorization: `Bearer ${this.secret}`,
              ...(serialized
                ? {
                    "Content-Type": "application/json",
                    "Content-Length": Buffer.byteLength(serialized),
                  }
                : {}),
            },
          },
          async (response) => {
            try {
              const chunks: Buffer[] = [];
              let size = 0;
              for await (const chunk of response) {
                size += chunk.length;
                if (size > 4096) throw new Error();
                chunks.push(Buffer.from(chunk));
              }
              if (method === "DELETE" && response.statusCode === 404) return resolve({ ok: true });
              const result: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
              if (
                method === "POST" &&
                response.statusCode === 409 &&
                result &&
                typeof result === "object" &&
                !Array.isArray(result) &&
                "ok" in result &&
                result.ok === false &&
                "error" in result &&
                result.error === "busy" &&
                Object.keys(result).length === 2
              )
                return reject(new WorkerBusyError());
              if (
                response.statusCode !== 200 ||
                !result ||
                typeof result !== "object" ||
                !("ok" in result) ||
                result.ok !== true
              )
                throw new Error();
              resolve(result);
            } catch {
              reject(new MediaConversionError("conversion_failed"));
            } finally {
              response.destroy();
            }
          },
        );
        req.once("error", () =>
          reject(
            new MediaConversionError(
              combined.aborted ? "conversion_cancelled" : "converter_unavailable",
            ),
          ),
        );
        req.end(serialized);
      });
    } catch (error) {
      if (error instanceof WorkerBusyError) throw error;
      throw new MediaConversionError(
        signal?.aborted ? "conversion_cancelled" : "conversion_failed",
      );
    }
  }

  async health(): Promise<void> {
    await this.call("GET", "/health");
  }

  async cancel(id: string): Promise<void> {
    this.assertId(id);
    await this.call("DELETE", `/jobs/${id}`);
  }

  async convert(
    id: string,
    sha256: string,
    maxDurationSeconds: number,
    signal: AbortSignal,
  ): Promise<{ bytes: number; sha256: string; durationSeconds: number }> {
    this.assertId(id);
    if (
      !/^[a-f0-9]{64}$(?![\s\S])/.test(sha256) ||
      !Number.isSafeInteger(maxDurationSeconds) ||
      maxDurationSeconds < 1 ||
      maxDurationSeconds > MAX_ASR_DURATION_SECONDS
    )
      throw new MediaConversionError("conversion_failed");
    const result = await this.runJob(id, "convert", { sha256, maxDurationSeconds }, signal);
    const value = result as Record<string, unknown>;
    if (
      typeof value.bytes !== "number" ||
      !Number.isSafeInteger(value.bytes) ||
      value.bytes <= 0 ||
      value.bytes > Math.min(MAX_ASR_WAV_BYTES, maxDurationSeconds * 32_000 + 65_536) ||
      typeof value.sha256 !== "string" ||
      !/^[a-f0-9]{64}$(?![\s\S])/.test(value.sha256) ||
      typeof value.durationSeconds !== "number" ||
      !Number.isFinite(value.durationSeconds) ||
      value.durationSeconds <= 0 ||
      value.durationSeconds > maxDurationSeconds
    )
      throw new MediaConversionError("conversion_failed");
    return { bytes: value.bytes, sha256: value.sha256, durationSeconds: value.durationSeconds };
  }

  async muxVideo(
    id: string,
    input: {
      videoSha256: string;
      audioSha256: string;
      maxDurationSeconds: number;
      maxBytes: number;
    },
    signal: AbortSignal,
  ): Promise<{ bytes: number; sha256: string; durationSeconds: number }> {
    this.assertId(id);
    if (
      !/^[a-f0-9]{64}$(?![\s\S])/.test(input.videoSha256) ||
      !/^[a-f0-9]{64}$(?![\s\S])/.test(input.audioSha256) ||
      !Number.isSafeInteger(input.maxDurationSeconds) ||
      input.maxDurationSeconds < 1 ||
      !Number.isSafeInteger(input.maxBytes) ||
      input.maxBytes < 1 ||
      input.maxBytes > 50_000_000
    )
      throw new MediaConversionError("conversion_failed");
    const value = (await this.runJob(id, "mux-video", input, signal)) as Record<string, unknown>;
    if (
      typeof value.bytes !== "number" ||
      !Number.isSafeInteger(value.bytes) ||
      value.bytes <= 0 ||
      value.bytes > input.maxBytes ||
      typeof value.sha256 !== "string" ||
      !/^[a-f0-9]{64}$(?![\s\S])/.test(value.sha256) ||
      typeof value.durationSeconds !== "number" ||
      !Number.isFinite(value.durationSeconds) ||
      value.durationSeconds <= 0 ||
      value.durationSeconds > input.maxDurationSeconds
    )
      throw new MediaConversionError("conversion_failed");
    return { bytes: value.bytes, sha256: value.sha256, durationSeconds: value.durationSeconds };
  }

  private assertId(id: string) {
    if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$(?![\s\S])/.test(id))
      throw new MediaConversionError("conversion_failed");
  }
}
