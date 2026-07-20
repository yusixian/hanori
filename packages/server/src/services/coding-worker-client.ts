import type { GitHubCodingModelConfig } from "@cos-tool-bot/shared";
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { request as httpRequest } from "node:http";

export type CodingWorkerModel = GitHubCodingModelConfig;

export interface CodingWorkerJob {
  workspacePath: string;
  task: string;
  timeoutMs: number;
  model: CodingWorkerModel;
}

export interface CodingWorkerResult {
  summary: string;
  durationMs: number;
}

export interface CodingWorkerClientOptions {
  url: string;
  socketPath?: string;
  secret: string;
  fetch?: typeof fetch;
  restartTimeoutMs?: number;
  pollIntervalMs?: number;
  sleep?: (milliseconds: number) => Promise<void>;
}

interface WorkerHealth {
  ok: true;
  bootId: string;
  challenge: string;
  proof: string;
}

function healthProof(secret: string, challenge: string, bootId: string): Buffer {
  return createHmac("sha256", secret)
    .update("cos-tool-bot/coding-worker-health/v1\0")
    .update(challenge)
    .update("\0")
    .update(bootId)
    .digest();
}

function hasValidHealthProof(
  value: unknown,
  secret: string,
  expectedChallenge: string,
): value is WorkerHealth {
  if (!value || typeof value !== "object") return false;
  const health = value as Partial<WorkerHealth>;
  if (
    health.ok !== true ||
    typeof health.bootId !== "string" ||
    !health.bootId ||
    health.challenge !== expectedChallenge ||
    typeof health.proof !== "string"
  ) {
    return false;
  }
  let received: Buffer;
  try {
    received = Buffer.from(health.proof, "base64url");
  } catch {
    return false;
  }
  const expected = healthProof(secret, expectedChallenge, health.bootId);
  return received.length === expected.length && timingSafeEqual(received, expected);
}

function isCodingWorkerResult(value: unknown): value is CodingWorkerResult {
  if (!value || typeof value !== "object") return false;
  const result = value as Partial<CodingWorkerResult>;
  return (
    typeof result.summary === "string" &&
    typeof result.durationMs === "number" &&
    Number.isFinite(result.durationMs) &&
    result.durationMs >= 0
  );
}

export class CodingWorkerClient {
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly options: CodingWorkerClientOptions) {
    this.fetchImpl = options.fetch ?? fetch;
  }

  get configured(): boolean {
    return Boolean((this.options.socketPath || this.options.url) && this.options.secret);
  }

  async run(job: CodingWorkerJob, signal?: AbortSignal): Promise<CodingWorkerResult> {
    if (!this.configured) throw new Error("Pi coding worker is not configured");
    signal?.throwIfAborted();
    const before = await this.waitForHealthyWorker(undefined, signal);
    let response: Response;
    const timeoutSignal = AbortSignal.timeout(job.timeoutMs + 30_000);
    try {
      response = await this.request("/jobs", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.options.secret}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(job),
        signal: signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal,
      });
    } catch (error) {
      await this.waitForHealthyWorker(before.bootId);
      throw error;
    }
    const payload: unknown = await response.json().catch(() => null);
    await this.waitForHealthyWorker(before.bootId);
    signal?.throwIfAborted();
    const record =
      payload && typeof payload === "object" ? (payload as Record<string, unknown>) : null;
    if (!response.ok || record?.ok !== true || !isCodingWorkerResult(record.result)) {
      const detail = typeof record?.error === "string" ? record.error : undefined;
      const safeDetail = detail?.split(job.model.apiKey).join("[redacted]");
      throw new Error(
        `Pi coding worker failed (${response.status})${safeDetail ? `: ${safeDetail}` : ""}`,
      );
    }
    return record.result;
  }

  private async request(pathname: string, init: RequestInit = {}): Promise<Response> {
    if (!this.options.socketPath) {
      return this.fetchImpl(`${this.options.url.replace(/\/+$/, "")}${pathname}`, init);
    }
    return new Promise((resolve, reject) => {
      const headers = new Headers(init.headers);
      const body = typeof init.body === "string" ? init.body : undefined;
      if (body) headers.set("Content-Length", String(Buffer.byteLength(body)));
      const request = httpRequest({
        socketPath: this.options.socketPath,
        path: pathname,
        method: init.method ?? "GET",
        headers: Object.fromEntries(headers),
      });
      const onAbort = () => request.destroy(init.signal?.reason as Error | undefined);
      init.signal?.addEventListener("abort", onAbort, { once: true });
      request.on("response", (incoming) => {
        const chunks: Buffer[] = [];
        let bytes = 0;
        incoming.on("data", (chunk: Buffer) => {
          bytes += chunk.length;
          if (bytes > 256 * 1024) {
            request.destroy(new Error("Pi coding worker response is too large"));
            return;
          }
          chunks.push(chunk);
        });
        incoming.on("end", () => {
          init.signal?.removeEventListener("abort", onAbort);
          const responseHeaders = new Headers();
          for (const [name, value] of Object.entries(incoming.headers)) {
            if (Array.isArray(value)) responseHeaders.set(name, value.join(", "));
            else if (value !== undefined) responseHeaders.set(name, value);
          }
          resolve(
            new Response(Buffer.concat(chunks), {
              status: incoming.statusCode ?? 500,
              headers: responseHeaders,
            }),
          );
        });
      });
      request.on("error", (error) => {
        init.signal?.removeEventListener("abort", onAbort);
        reject(error);
      });
      if (body) request.write(body);
      request.end();
    });
  }

  private async waitForHealthyWorker(
    differentFrom?: string,
    signal?: AbortSignal,
  ): Promise<WorkerHealth> {
    const timeoutMs = this.options.restartTimeoutMs ?? 60_000;
    const deadline = Date.now() + timeoutMs;
    let lastError: unknown;
    while (Date.now() <= deadline) {
      signal?.throwIfAborted();
      try {
        const challenge = randomBytes(32).toString("base64url");
        const healthTimeout = AbortSignal.timeout(Math.min(5_000, timeoutMs));
        const response = await this.request(`/health?challenge=${challenge}`, {
          signal: signal ? AbortSignal.any([signal, healthTimeout]) : healthTimeout,
        });
        const payload: unknown = await response.json().catch(() => null);
        if (
          response.ok &&
          hasValidHealthProof(payload, this.options.secret, challenge) &&
          payload.bootId !== differentFrom
        ) {
          return payload;
        }
      } catch (error) {
        lastError = error;
      }
      await (
        this.options.sleep ??
        ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)))
      )(this.options.pollIntervalMs ?? 250);
    }
    const detail = lastError instanceof Error ? `: ${lastError.message}` : "";
    throw new Error(`Pi coding worker did not restart with a new boot id${detail}`);
  }
}
