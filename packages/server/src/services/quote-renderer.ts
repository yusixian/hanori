import { request } from "node:http";
import { isAbsolute } from "node:path";
import type { QuoteRenderInput, QuoteRenderResult } from "@cos-tool-bot/shared";

export class QuoteRendererError extends Error {
  constructor(
    readonly code: "unavailable" | "busy" | "cancelled" | "invalid_input" | "render_failed",
  ) {
    super(code);
    this.name = "QuoteRendererError";
  }
}

/** Only the dedicated local Unix socket is reachable; user input cannot select an endpoint. */
export class QuoteRendererClient {
  private health?: { until: number; available: boolean };
  private readonly socketPath: string;
  private readonly timeoutMs: number;

  constructor({ socketPath, timeoutMs = 16_000 }: { socketPath: string; timeoutMs?: number }) {
    if (!isAbsolute(socketPath)) throw new QuoteRendererError("unavailable");
    this.socketPath = socketPath;
    this.timeoutMs = timeoutMs;
  }

  private async call(path: "/health" | "/render", body?: string, signal?: AbortSignal) {
    const combined = AbortSignal.any([
      AbortSignal.timeout(path === "/health" ? 1500 : this.timeoutMs),
      ...(signal ? [signal] : []),
    ]);
    return new Promise<{ bytes: Buffer; headers: import("node:http").IncomingHttpHeaders }>(
      (resolve, reject) => {
        const req = request(
          {
            socketPath: this.socketPath,
            path,
            method: body === undefined ? "GET" : "POST",
            signal: combined,
            headers:
              body === undefined
                ? {}
                : { "content-type": "application/json", "content-length": Buffer.byteLength(body) },
          },
          async (response) => {
            try {
              if (response.statusCode !== 200)
                throw new QuoteRendererError(
                  response.statusCode === 409
                    ? "busy"
                    : response.statusCode === 503
                      ? "unavailable"
                      : "render_failed",
                );
              const chunks: Buffer[] = [];
              let length = 0;
              for await (const chunk of response) {
                length += chunk.length;
                if (length > (path === "/health" ? 4096 : 8 * 1024 * 1024))
                  throw new QuoteRendererError("render_failed");
                chunks.push(Buffer.from(chunk));
              }
              resolve({ bytes: Buffer.concat(chunks), headers: response.headers });
            } catch (error) {
              reject(
                error instanceof QuoteRendererError
                  ? error
                  : new QuoteRendererError(signal?.aborted ? "cancelled" : "render_failed"),
              );
            } finally {
              response.destroy();
            }
          },
        );
        req.once("error", () =>
          reject(new QuoteRendererError(signal?.aborted ? "cancelled" : "unavailable")),
        );
        req.end(body);
      },
    );
  }

  async available(): Promise<boolean> {
    if (this.health && this.health.until > Date.now()) return this.health.available;
    let available = false;
    try {
      const { bytes } = await this.call("/health");
      const result: unknown = JSON.parse(bytes.toString("utf8"));
      available =
        !!result &&
        typeof result === "object" &&
        "ok" in result &&
        result.ok === true &&
        "renderer" in result &&
        result.renderer === "pango-cairo" &&
        "version" in result &&
        result.version === 1;
    } catch {
      available = false;
    }
    this.health = { available, until: Date.now() + (available ? 5000 : 1000) };
    return available;
  }

  async render(input: QuoteRenderInput, signal?: AbortSignal): Promise<QuoteRenderResult> {
    if (signal?.aborted) throw new QuoteRendererError("cancelled");
    const body = JSON.stringify(input);
    if (Buffer.byteLength(body) > 34 * 1024 * 1024) throw new QuoteRendererError("invalid_input");
    const { bytes, headers } = await this.call("/render", body, signal);
    const format =
      headers["content-type"] === "image/webp"
        ? "webp"
        : headers["content-type"] === "image/png"
          ? "png"
          : undefined;
    const width = Number(headers["x-quote-width"]);
    const height = Number(headers["x-quote-height"]);
    if (
      !format ||
      !Number.isSafeInteger(width) ||
      !Number.isSafeInteger(height) ||
      width <= 0 ||
      width > 512 ||
      height <= 0 ||
      height > 4096 ||
      !bytes.length
    )
      throw new QuoteRendererError("render_failed");
    if (format === "webp" && (Math.max(width, height) !== 512 || bytes.length > 512 * 1024))
      throw new QuoteRendererError("render_failed");
    if (
      format === "png"
        ? !bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
        : bytes.toString("ascii", 0, 4) !== "RIFF" || bytes.toString("ascii", 8, 12) !== "WEBP"
    )
      throw new QuoteRendererError("render_failed");
    return { data: bytes, format, width, height };
  }
}
