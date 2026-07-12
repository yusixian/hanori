import type { ModelCapability } from "@cos-tool-bot/shared";
import { inferCapabilities as heuristicInfer } from "@cos-tool-bot/shared";
import type { Logger } from "pino";

const MODELS_DEV_URL = "https://models.dev/api.json";
const REFRESH_INTERVAL_MS = 6 * 60 * 60 * 1000; // 6 hours

interface ModelsDevEntry {
  name?: string;
  provider?: string;
  modalities?: {
    input?: string[];
    output?: string[];
  };
  tool_call?: boolean;
  reasoning?: boolean;
  attachment?: boolean;
}

type ModelsDevData = Record<string, ModelsDevEntry>;

export class ModelCapabilityService {
  private cache = new Map<string, ModelCapability[]>();
  private refreshTimer: ReturnType<typeof setInterval> | null = null;
  private logger: Logger;

  constructor(logger: Logger) {
    this.logger = logger;
  }

  async init(): Promise<void> {
    try {
      await this.refresh();
    } catch (err) {
      this.logger.warn(
        err,
        "ModelCapabilityService: initial fetch failed, falling back to heuristics",
      );
    }
    this.refreshTimer = setInterval(() => {
      this.refresh().catch((err) => {
        this.logger.warn(err, "ModelCapabilityService: refresh failed");
      });
    }, REFRESH_INTERVAL_MS);
    this.refreshTimer.unref();
  }

  stop(): void {
    if (this.refreshTimer) {
      clearInterval(this.refreshTimer);
      this.refreshTimer = null;
    }
  }

  getHandle(): ReturnType<typeof setInterval> | null {
    return this.refreshTimer;
  }

  getIntervalMs(): number {
    return REFRESH_INTERVAL_MS;
  }

  private async refresh(): Promise<void> {
    const res = await fetch(MODELS_DEV_URL, { signal: AbortSignal.timeout(15_000) });
    if (!res.ok) throw new Error(`models.dev HTTP ${res.status}`);
    const data = (await res.json()) as ModelsDevData;

    const newCache = new Map<string, ModelCapability[]>();
    for (const [modelId, entry] of Object.entries(data)) {
      const caps = this.mapCapabilities(modelId, entry);
      newCache.set(modelId, caps);
    }
    this.cache = newCache;
    this.logger.info(`ModelCapabilityService: loaded ${newCache.size} models from models.dev`);
  }

  private mapCapabilities(modelId: string, entry: ModelsDevEntry): ModelCapability[] {
    const caps: ModelCapability[] = [];

    // Vision: attachment flag or image in input modalities
    if (entry.attachment || entry.modalities?.input?.includes("image")) {
      caps.push("vision");
    }

    // Tool calling
    if (entry.tool_call) {
      caps.push("tool_calling");
    }

    // Reasoning
    if (entry.reasoning) {
      caps.push("reasoning");
    }

    // Supplement with heuristic-only capabilities (API doesn't provide these)
    const lower = modelId.toLowerCase();
    if (
      lower.includes("code") ||
      lower.includes("coder") ||
      lower.includes("deepseek") ||
      lower.includes("gpt-4") ||
      lower.includes("claude") ||
      lower.includes("gemini")
    ) {
      caps.push("code");
    }

    if (lower.includes("long") || lower.includes("128k") || lower.includes("200k")) {
      caps.push("long_context");
    }

    if (lower.includes("search") || lower.includes("online") || lower.includes("gemini")) {
      // Gemini models have built-in grounding/search
      if (lower.includes("gemini")) caps.push("web_search");
      else if (lower.includes("search") || lower.includes("online")) caps.push("web_search");
    }

    return [...new Set(caps)];
  }

  inferCapabilities(modelId: string): ModelCapability[] {
    // 1. Exact match from API cache
    const exact = this.cache.get(modelId);
    if (exact) return exact;

    // 2. Prefix match (e.g. "gpt-4o-2024-11-20" → "gpt-4o").
    //    Longest key first so "o1-mini" wins over "o1".
    const byKeyLengthDesc = [...this.cache].sort(([a], [b]) => b.length - a.length);
    for (const [key, caps] of byKeyLengthDesc) {
      if (modelId.startsWith(key)) return caps;
    }

    // 3. Fallback to shared heuristic
    return heuristicInfer(modelId);
  }
}
