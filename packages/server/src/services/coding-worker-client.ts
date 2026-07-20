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
  secret: string;
  fetch?: typeof fetch;
}

export class CodingWorkerClient {
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly options: CodingWorkerClientOptions) {
    this.fetchImpl = options.fetch ?? fetch;
  }

  get configured(): boolean {
    return Boolean(this.options.url && this.options.secret);
  }

  async run(job: CodingWorkerJob): Promise<CodingWorkerResult> {
    if (!this.configured) throw new Error("Pi coding worker is not configured");
    const response = await this.fetchImpl(`${this.options.url.replace(/\/+$/, "")}/jobs`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.options.secret}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(job),
      signal: AbortSignal.timeout(job.timeoutMs + 30_000),
    });
    const payload = (await response.json().catch(() => null)) as
      | { ok: true; result: CodingWorkerResult }
      | { error?: string }
      | null;
    if (!response.ok || !payload || !("ok" in payload)) {
      const detail = payload && "error" in payload ? payload.error : undefined;
      const safeDetail = detail?.split(job.model.apiKey).join("[redacted]");
      throw new Error(
        `Pi coding worker failed (${response.status})${safeDetail ? `: ${safeDetail}` : ""}`,
      );
    }
    return payload.result;
  }
}
