import { request } from "node:http";
import { isAbsolute } from "node:path";

export class MediaConversionError extends Error {
  constructor(
    readonly code: "converter_unavailable" | "conversion_failed" | "conversion_cancelled",
  ) {
    super(code);
    this.name = "MediaConversionError";
  }
}

/** Connects only to a host-configured Unix socket; never sends URLs or provider credentials. */
export class IsolatedAudioConverter {
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
    } catch {
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
      !/^[a-f0-9]{64}$/.test(sha256) ||
      !Number.isSafeInteger(maxDurationSeconds) ||
      maxDurationSeconds < 1 ||
      maxDurationSeconds > 600
    )
      throw new MediaConversionError("conversion_failed");
    const result = await this.call(
      "POST",
      `/jobs/${id}/convert`,
      { sha256, maxDurationSeconds },
      signal,
      130_000,
    );
    const value = result as Record<string, unknown>;
    if (
      typeof value.bytes !== "number" ||
      !Number.isSafeInteger(value.bytes) ||
      value.bytes <= 0 ||
      value.bytes > 20 * 1024 * 1024 ||
      typeof value.sha256 !== "string" ||
      !/^[a-f0-9]{64}$/.test(value.sha256) ||
      typeof value.durationSeconds !== "number" ||
      !Number.isFinite(value.durationSeconds) ||
      value.durationSeconds <= 0 ||
      value.durationSeconds > maxDurationSeconds
    )
      throw new MediaConversionError("conversion_failed");
    return { bytes: value.bytes, sha256: value.sha256, durationSeconds: value.durationSeconds };
  }

  private assertId(id: string) {
    if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(id))
      throw new MediaConversionError("conversion_failed");
  }
}
