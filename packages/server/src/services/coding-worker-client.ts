export interface CodingWorkerModel {
  apiKey: string;
  baseURL: string;
  id: string;
  providerFormat: "openai" | "gemini";
  maxTokens?: number;
}

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

  async run(job: CodingWorkerJob): Promise<CodingWorkerResult> {
    if (!this.configured) throw new Error("Pi coding worker is not configured");
    const before = await this.waitForHealthyWorker();
    let response: Response;
    try {
      response = await this.request("/jobs", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.options.secret}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(job),
        signal: AbortSignal.timeout(job.timeoutMs + 30_000),
      });
    } catch (error) {
      await this.waitForHealthyWorker(before.bootId);
      throw error;
    }
    const payload: unknown = await response.json().catch(() => null);
    await this.waitForHealthyWorker(before.bootId);
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

  private async waitForHealthyWorker(differentFrom?: string): Promise<WorkerHealth> {
    const timeoutMs = this.options.restartTimeoutMs ?? 60_000;
    const deadline = Date.now() + timeoutMs;
    let lastError: unknown;
    while (Date.now() <= deadline) {
      try {
        const response = await this.request("/health", {
          signal: AbortSignal.timeout(Math.min(5_000, timeoutMs)),
        });
        const payload: unknown = await response.json().catch(() => null);
        if (
          response.ok &&
          payload &&
          typeof payload === "object" &&
          (payload as Partial<WorkerHealth>).ok === true &&
          typeof (payload as Partial<WorkerHealth>).bootId === "string" &&
          (payload as Partial<WorkerHealth>).bootId &&
          (payload as Partial<WorkerHealth>).bootId !== differentFrom
        ) {
          return payload as WorkerHealth;
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
import { request as httpRequest } from "node:http";
