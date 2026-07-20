import type { GitHubCodingModelConfig } from "@cos-tool-bot/shared";
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { request as httpRequest, type ClientRequest } from "node:http";
import { request as httpsRequest } from "node:https";

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

const ACCEPTED_BOOT_HEADER = "x-coding-worker-accepted-boot-id";

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
  private requiredFreshBootId?: string;

  constructor(private readonly options: CodingWorkerClientOptions) {
    this.fetchImpl = options.fetch ?? fetch;
  }

  get configured(): boolean {
    return Boolean((this.options.socketPath || this.options.url) && this.options.secret);
  }

  async waitForFreshBoot(signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted();
    const requiredFreshBootId = this.requiredFreshBootId;
    if (!requiredFreshBootId) return;
    await this.waitForHealthyWorker(requiredFreshBootId, signal);
    if (this.requiredFreshBootId === requiredFreshBootId) {
      this.requiredFreshBootId = undefined;
    }
  }

  async run(job: CodingWorkerJob, signal?: AbortSignal): Promise<CodingWorkerResult> {
    if (!this.configured) throw new Error("Pi coding worker is not configured");
    signal?.throwIfAborted();
    const requiredFreshBootId = this.requiredFreshBootId;
    const before = await this.waitForHealthyWorker(requiredFreshBootId, signal);
    if (requiredFreshBootId && this.requiredFreshBootId === requiredFreshBootId) {
      this.requiredFreshBootId = undefined;
    }
    let response: Response;
    let accepted = false;
    const timeoutSignal = AbortSignal.timeout(job.timeoutMs + 30_000);
    const requestSignal = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
    try {
      response = await this.request(
        "/jobs",
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${this.options.secret}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ expectedBootId: before.bootId, job }),
          signal: requestSignal,
        },
        () => {
          accepted = true;
          this.requiredFreshBootId = before.bootId;
        },
        before.bootId,
      );
    } catch (error) {
      const originalError = signal?.aborted ? signal.reason : error;
      if (accepted) {
        try {
          await this.waitForHealthyWorker(before.bootId, requestSignal);
          if (this.requiredFreshBootId === before.bootId) this.requiredFreshBootId = undefined;
        } catch (restartError) {
          if (!requestSignal.aborted) throw restartError;
        }
      }
      throw originalError;
    }
    const payload: unknown = await response.json().catch(() => null);
    if (accepted) {
      try {
        await this.waitForHealthyWorker(before.bootId, requestSignal);
        if (this.requiredFreshBootId === before.bootId) this.requiredFreshBootId = undefined;
      } catch (restartError) {
        if (!requestSignal.aborted) throw restartError;
      }
    }
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

  private async request(
    pathname: string,
    init: RequestInit = {},
    onAccepted?: () => void,
    expectedBootId?: string,
  ): Promise<Response> {
    init.signal?.throwIfAborted();
    if (!this.options.socketPath && this.options.fetch) {
      const response = await this.fetchImpl(
        `${this.options.url.replace(/\/+$/, "")}${pathname}`,
        init,
      );
      const acceptedBootId = response.headers.get(ACCEPTED_BOOT_HEADER);
      if (acceptedBootId) {
        if (!expectedBootId || acceptedBootId !== expectedBootId) {
          throw new Error("Pi coding worker returned an invalid accepted boot id");
        }
        onAccepted?.();
      }
      return response;
    }
    return new Promise((resolve, reject) => {
      const headers = new Headers(init.headers);
      const body = typeof init.body === "string" ? init.body : undefined;
      if (body) headers.set("Content-Length", String(Buffer.byteLength(body)));
      const request = this.openRequest(pathname, init.method ?? "GET", headers);
      let accepted = false;
      const markAccepted = () => {
        if (accepted) return;
        accepted = true;
        onAccepted?.();
      };
      request.on("information", (information) => {
        if (information.statusCode === 102) markAccepted();
      });
      const onAbort = () => {
        const reason = init.signal?.reason;
        reject(reason);
        request.destroy(reason instanceof Error ? reason : undefined);
      };
      init.signal?.addEventListener("abort", onAbort, { once: true });
      request.on("response", (incoming) => {
        const acceptedHeader = incoming.headers[ACCEPTED_BOOT_HEADER];
        const acceptedBootId = Array.isArray(acceptedHeader) ? acceptedHeader[0] : acceptedHeader;
        if (acceptedBootId) {
          if (!expectedBootId || acceptedBootId !== expectedBootId) {
            init.signal?.removeEventListener("abort", onAbort);
            incoming.resume();
            reject(new Error("Pi coding worker returned an invalid accepted boot id"));
            request.destroy();
            return;
          }
          markAccepted();
        }
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

  private openRequest(pathname: string, method: string, headers: Headers): ClientRequest {
    const options = { method, headers: Object.fromEntries(headers) };
    if (this.options.socketPath) {
      return httpRequest({ ...options, socketPath: this.options.socketPath, path: pathname });
    }
    const target = new URL(`${this.options.url.replace(/\/+$/, "")}${pathname}`);
    if (target.username || target.password) {
      throw new Error("Pi coding worker URL must not contain credentials");
    }
    if (target.protocol === "http:") return httpRequest(target, options);
    if (target.protocol === "https:") return httpsRequest(target, options);
    throw new Error("Pi coding worker URL must use http: or https:");
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
        if (signal?.aborted) signal.throwIfAborted();
        lastError = error;
      }
      await this.sleep(this.options.pollIntervalMs ?? 250, signal);
    }
    const detail = lastError instanceof Error ? `: ${lastError.message}` : "";
    throw new Error(`Pi coding worker did not restart with a new boot id${detail}`);
  }

  private async sleep(milliseconds: number, signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted();
    const pending = (
      this.options.sleep ?? ((delay) => new Promise((resolve) => setTimeout(resolve, delay)))
    )(milliseconds);
    if (!signal) return pending;
    await new Promise<void>((resolve, reject) => {
      const onAbort = () => reject(signal.reason);
      signal.addEventListener("abort", onAbort, { once: true });
      pending.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
    });
  }
}
