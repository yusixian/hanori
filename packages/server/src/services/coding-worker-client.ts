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
    const payload: unknown = await response.json().catch(() => null);
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
}
