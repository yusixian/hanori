import { MAX_TOOL_CALLS_PER_REQUEST } from "@cos-tool-bot/shared";
import type { Tool, JSONValue } from "ai";
import { jsonSchema } from "ai";
import { z } from "zod";

/**
 * Convert a Zod v4 schema to an AI SDK-compatible JSON Schema.
 * The AI SDK internally uses `zod-to-json-schema` (designed for Zod v3),
 * which produces invalid output with Zod v4. This helper uses Zod v4's
 * native `z.toJSONSchema()` and wraps the result with AI SDK's `jsonSchema()`.
 */
export function zodToAiSchema<T extends z.ZodType>(schema: T) {
  const json = z.toJSONSchema(schema, { unrepresentable: "any", io: "input" });
  return jsonSchema<z.infer<T>>(json as JSONValue);
}

/**
 * Tracks which side-effect tools have already been executed within a single
 * `generateText` call. Shared across all tool factories for one request.
 */
export interface OnceGuardContext {
  /** Returns true if the tool has already fired. */
  hasFired(toolName: string): boolean;
  /** Marks the tool as fired. */
  markFired(toolName: string): void;
}

export function createOnceGuard(): OnceGuardContext {
  const fired = new Set<string>();
  return {
    hasFired: (name) => fired.has(name),
    markFired: (name) => {
      fired.add(name);
    },
  };
}

// ---------------------------------------------------------------------------
// Per-request tool call cache + rate limiting
// ---------------------------------------------------------------------------

export interface RequestCache {
  getCachedResult(key: string): unknown;
  setCachedResult(key: string, result: unknown): void;
  incrementCallCount(toolName: string): number;
  incrementTotalCallCount(): number;
}

export function createRequestCache(): RequestCache {
  const cache = new Map<string, unknown>();
  const callCounts = new Map<string, number>();
  let totalCallCount = 0;
  return {
    getCachedResult: (key) => cache.get(key),
    setCachedResult: (key, result) => {
      cache.set(key, result);
    },
    incrementCallCount: (toolName) => {
      const count = (callCounts.get(toolName) ?? 0) + 1;
      callCounts.set(toolName, count);
      return count;
    },
    incrementTotalCallCount: () => ++totalCallCount,
  };
}

const TWITTER_HOSTS = new Set([
  "twitter.com",
  "x.com",
  "vxtwitter.com",
  "fxtwitter.com",
  "api.vxtwitter.com",
  "api.fxtwitter.com",
  "fixvx.com",
]);
const TWITTER_STATUS_RE = /\/[^/]+\/status\/(\d+)/;
const PIXIV_ARTWORKS_RE = /\/(?:en\/)?(?:artworks|i)\/(\d+)/;

/** Normalize URLs for cache deduplication. */
export function normalizeUrlForCache(url: string): string {
  try {
    const u = new URL(url);
    const host = u.hostname.toLowerCase();

    // Twitter variants → tweet:{postId}
    if (TWITTER_HOSTS.has(host) || host.endsWith(".twitter.com") || host.endsWith(".x.com")) {
      const m = u.pathname.match(TWITTER_STATUS_RE);
      if (m) return `tweet:${m[1]}`;
    }

    // Pixiv
    if (host === "www.pixiv.net" || host === "pixiv.net") {
      const m = u.pathname.match(PIXIV_ARTWORKS_RE);
      if (m) return `pixiv:${m[1]}`;
    }

    // Generic: host + pathname (strip tracking params)
    return `${host}${u.pathname}`;
  } catch {
    return url.toLowerCase();
  }
}

const TOOL_CALL_LIMITS: Record<string, number> = {
  fetch_webpage: 128,
  web_search: 64,
  fetch_artwork_info: 64,
  delegate_task: 64,
  search_danbooru_character_tags: 64,
};

const CACHEABLE_TOOLS = new Set(["fetch_webpage", "web_search", "fetch_artwork_info"]);

function buildCacheKey(toolName: string, args: Record<string, unknown>): string {
  if (toolName === "fetch_artwork_info" || toolName === "fetch_webpage") {
    const url = String(args.url ?? "");
    return `${toolName}:${normalizeUrlForCache(url)}`;
  }
  if (toolName === "web_search") {
    const query = String(args.query ?? "")
      .toLowerCase()
      .trim();
    return `${toolName}:${query}`;
  }
  return `${toolName}:${JSON.stringify(args)}`;
}

/**
 * Wraps every executable tool with a generous total request budget. Selected
 * read-only tools additionally receive deduplication and per-tool limits.
 */
export function wrapToolsWithCache(
  tools: Record<string, Tool>,
  cache: RequestCache,
): Record<string, Tool> {
  const wrapped: Record<string, Tool> = {};
  for (const [name, tool] of Object.entries(tools)) {
    if (!("execute" in tool) || typeof tool.execute !== "function") {
      wrapped[name] = tool;
      continue;
    }
    const originalExecute = tool.execute as (args: any, options: any) => PromiseLike<any>;
    wrapped[name] = {
      ...tool,
      execute: async (toolArgs: any, options: any) => {
        const totalCount = cache.incrementTotalCallCount();
        if (totalCount > MAX_TOOL_CALLS_PER_REQUEST) {
          return {
            blocked: true,
            reason: `已达到本次请求的工具调用总上限 (${MAX_TOOL_CALLS_PER_REQUEST})，请使用已有信息完成回复。`,
          };
        }

        if (!CACHEABLE_TOOLS.has(name) && !(name in TOOL_CALL_LIMITS)) {
          return originalExecute(toolArgs, options);
        }

        const args = (toolArgs ?? {}) as Record<string, unknown>;
        const cacheable = CACHEABLE_TOOLS.has(name);
        const key = cacheable ? buildCacheKey(name, args) : undefined;
        if (key) {
          const cached = cache.getCachedResult(key);
          if (cached !== undefined) {
            return typeof cached === "object" && cached !== null && !Array.isArray(cached)
              ? { ...(cached as Record<string, unknown>), _cached: true, _note: "已获取过相同内容" }
              : { result: cached, _cached: true, _note: "已获取过相同内容" };
          }
        }

        const limit = TOOL_CALL_LIMITS[name] ?? Infinity;
        const count = cache.incrementCallCount(name);
        if (count > limit) {
          return {
            blocked: true,
            reason: `已达到 ${name} 的调用次数上限 (${limit})，请使用已有信息完成回复。`,
          };
        }

        const result = await originalExecute(toolArgs, options);
        if (key) cache.setCachedResult(key, result);
        return result;
      },
    };
  }
  return wrapped;
}

// ---------------------------------------------------------------------------
// Per-step abort for generateText multi-step timeout
// ---------------------------------------------------------------------------

export interface PerStepAbort {
  signal: AbortSignal;
  reset: () => void;
  pause: () => void;
  resume: () => void;
  cleanup: () => void;
}

/**
 * Creates a per-step abort controller that aborts if any single step
 * (AI model call) exceeds `perStepMs`. Call `reset()` in `onStepFinish`
 * to restart the timer for the next step. The returned signal also aborts
 * when the overall signal fires.
 */
export function createPerStepAbort(perStepMs: number, overallSignal: AbortSignal): PerStepAbort {
  const stepController = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let pauseDepth = 0;

  const schedule = () => {
    if (pauseDepth > 0 || stepController.signal.aborted) return;
    timer = setTimeout(
      () => stepController.abort(new Error(`Per-step timeout: ${perStepMs}ms exceeded`)),
      perStepMs,
    );
  };

  schedule();

  const signal = AbortSignal.any([overallSignal, stepController.signal]);

  const reset = () => {
    clearTimeout(timer);
    timer = undefined;
    schedule();
  };

  const pause = () => {
    pauseDepth++;
    if (pauseDepth === 1) {
      clearTimeout(timer);
      timer = undefined;
    }
  };

  const resume = () => {
    if (pauseDepth === 0) return;
    pauseDepth--;
    if (pauseDepth === 0) schedule();
  };

  const cleanup = () => {
    clearTimeout(timer);
    timer = undefined;
  };

  return { signal, reset, pause, resume, cleanup };
}

/**
 * Wraps a tool's execute function so it can only run once per generateText call.
 * Subsequent invocations return a blocked message instead of executing.
 */
/** `any` is needed to match AI SDK's dynamic tool execute signature */
export function wrapOnce(
  toolName: string,
  guard: OnceGuardContext,
  execute: (...args: any[]) => PromiseLike<any>,
): (...args: any[]) => PromiseLike<any> {
  return async (...args: any[]) => {
    if (guard.hasFired(toolName)) {
      return {
        blocked: true,
        reason: `Tool "${toolName}" has already been executed in this request. Duplicate call blocked.`,
      };
    }
    guard.markFired(toolName);
    return execute(...args);
  };
}
