import {
  DEFAULT_TIMEOUT_CONFIG,
  type BotLogEntry,
  type GenerationLibraryActor,
  type GenerationLibraryPort,
  type TimeoutConfig,
} from "@cos-tool-bot/shared";
import type { Tool } from "ai";
import { tool } from "ai";
import { z } from "zod";
import { zodToAiSchema } from "./utils.js";

const DANBOORU_ORIGIN = "https://danbooru.donmai.us";
const CACHE_TTL_MS = 12 * 60 * 60 * 1000;
const MAX_WIKI_SUMMARY_LENGTH = 1_200;

interface CacheEntry<T> {
  expiresAt: number;
  fetchedAt: number;
  value: T;
}

const queryCache = new Map<string, CacheEntry<DanbooruCharacterTag[]>>();

interface DanbooruAutocompleteItem {
  type?: unknown;
  label?: unknown;
  value?: unknown;
  category?: unknown;
  post_count?: unknown;
  antecedent?: unknown;
}

interface DanbooruWikiPage {
  title?: unknown;
  body?: unknown;
  other_names?: unknown;
}

export interface DanbooruCharacterTag {
  tag: string;
  label: string;
  matchedAlias?: string;
  postCount?: number;
  otherNames: string[];
  wikiSummary?: string;
  postsUrl: string;
}

export interface DanbooruToolOptions {
  fetch?: typeof fetch;
  timeoutConfig?: TimeoutConfig;
  generationLibraryPort?: GenerationLibraryPort;
  getActor?: () => GenerationLibraryActor;
  /** Disable local asset persistence for strictly read-only search registries. */
  persistSearchResults?: boolean;
  onLog?: (entry: BotLogEntry) => void | Promise<void>;
}

interface DanbooruSearchResult {
  tags: DanbooruCharacterTag[];
  fetchedAt: Date;
  stale: boolean;
}

export async function searchDanbooruCharacterTags(input: {
  query: string;
  limit?: number;
  fetch?: typeof fetch;
  timeoutMs?: number;
}): Promise<DanbooruCharacterTag[]> {
  return (await searchDanbooruCharacterTagsWithMetadata(input)).tags;
}

async function searchDanbooruCharacterTagsWithMetadata(input: {
  query: string;
  limit?: number;
  fetch?: typeof fetch;
  timeoutMs?: number;
}): Promise<DanbooruSearchResult> {
  const query = input.query.trim();
  const limit = Math.min(Math.max(input.limit ?? 8, 1), 20);
  const cacheKey = `${query.toLocaleLowerCase()}:${limit}`;
  const cached = queryCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) {
    return { tags: cached.value, fetchedAt: new Date(cached.fetchedAt), stale: false };
  }

  const fetchImpl = input.fetch ?? fetch;
  const timeoutMs = input.timeoutMs ?? DEFAULT_TIMEOUT_CONFIG.searchMs;
  const autocompleteUrl = new URL("/autocomplete.json", DANBOORU_ORIGIN);
  autocompleteUrl.searchParams.set("search[query]", query);
  autocompleteUrl.searchParams.set("search[type]", "tag_query");
  autocompleteUrl.searchParams.set("limit", String(Math.min(limit * 3, 50)));

  let autocomplete: unknown;
  try {
    autocomplete = await fetchJson<unknown>(fetchImpl, autocompleteUrl, timeoutMs);
  } catch (error) {
    if (cached) {
      return { tags: cached.value, fetchedAt: new Date(cached.fetchedAt), stale: true };
    }
    throw error;
  }
  const candidates = Array.isArray(autocomplete)
    ? autocomplete
        .filter(isCharacterAutocomplete)
        .map(toCharacterCandidate)
        .filter((item): item is DanbooruCharacterTag => item !== null)
        .slice(0, limit)
    : [];

  const enriched = await Promise.all(
    candidates.map(async (candidate) => {
      const wikiUrl = new URL("/wiki_pages.json", DANBOORU_ORIGIN);
      wikiUrl.searchParams.set("search[title]", candidate.tag);
      wikiUrl.searchParams.set("limit", "1");
      try {
        const pages = await fetchJson<unknown>(fetchImpl, wikiUrl, timeoutMs);
        const page = Array.isArray(pages) ? (pages[0] as DanbooruWikiPage | undefined) : undefined;
        if (!page) return candidate;
        return {
          ...candidate,
          otherNames: readStringArray(page.other_names),
          wikiSummary: summarizeWikiBody(page.body),
        };
      } catch {
        return candidate;
      }
    }),
  );

  const fetchedAt = Date.now();
  queryCache.set(cacheKey, {
    expiresAt: fetchedAt + CACHE_TTL_MS,
    fetchedAt,
    value: enriched,
  });
  return { tags: enriched, fetchedAt: new Date(fetchedAt), stale: false };
}

export function createDanbooruTools(options: DanbooruToolOptions = {}): Record<string, Tool> {
  return {
    search_danbooru_character_tags: tool({
      description:
        "快速查询 Danbooru 角色标签。支持中文、英文、日文、别名或部分名称，返回可直接用于绘图提示词的规范英文 tag、别名、作品数与 wiki 摘要；查角色 tag 时优先于通用 Web 搜索。",
      inputSchema: zodToAiSchema(
        z.object({
          query: z
            .string()
            .trim()
            .min(1)
            .max(200)
            .describe("角色名、别名或部分名称，可使用中文或英文"),
          limit: z.number().int().min(1).max(20).default(8).describe("最多返回的角色标签数"),
        }),
      ),
      execute: async ({ query, limit }) => {
        const result = await searchDanbooruCharacterTagsWithMetadata({
          query,
          limit,
          fetch: options.fetch,
          timeoutMs: options.timeoutConfig?.searchMs ?? DEFAULT_TIMEOUT_CONFIG.searchMs,
        });
        if (
          options.persistSearchResults !== false &&
          options.generationLibraryPort &&
          options.getActor
        ) {
          try {
            await options.generationLibraryPort.recordDanbooru(
              options.getActor(),
              result.tags,
              result.fetchedAt,
            );
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            try {
              await options.onLog?.({
                level: "warn",
                message: "Failed to record Danbooru character results",
                meta: {
                  queryLength: query.length,
                  resultCount: result.tags.length,
                  error: message.slice(0, 500),
                },
              });
            } catch {
              // Diagnostics must not turn a successful external lookup into a tool failure.
            }
          }
        }
        return {
          query,
          tags: result.tags,
          source: DANBOORU_ORIGIN,
          fetchedAt: result.fetchedAt.toISOString(),
          stale: result.stale,
          ...(result.stale
            ? {
                note: "Danbooru refresh failed; returning the last cached result, which may be outdated.",
              }
            : {}),
        };
      },
    }),
  };
}

function isCharacterAutocomplete(value: unknown): value is DanbooruAutocompleteItem {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const item = value as DanbooruAutocompleteItem;
  return item.category === 4 && typeof item.value === "string" && item.value.length > 0;
}

function toCharacterCandidate(item: DanbooruAutocompleteItem): DanbooruCharacterTag | null {
  if (typeof item.value !== "string" || !item.value) return null;
  return {
    tag: item.value,
    label: typeof item.label === "string" && item.label ? item.label : item.value,
    matchedAlias:
      typeof item.antecedent === "string" && item.antecedent ? item.antecedent : undefined,
    postCount: typeof item.post_count === "number" ? item.post_count : undefined,
    otherNames: [],
    postsUrl: `${DANBOORU_ORIGIN}/posts?tags=${encodeURIComponent(item.value)}`,
  };
}

async function fetchJson<T>(fetchImpl: typeof fetch, url: URL, timeoutMs: number): Promise<T> {
  const response = await fetchImpl(url, {
    headers: { "User-Agent": "Hanori/0.1 Danbooru tag lookup" },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) throw new Error(`Danbooru request failed (${response.status})`);
  return (await response.json()) as T;
}

function readStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string" && item.length > 0)
    : [];
}

function summarizeWikiBody(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const summary = value
    .replace(/\[\[[^\]|]+\|([^\]]+)\]\]/g, "$1")
    .replace(/\[\[([^\]]+)\]\]/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
  return summary ? summary.slice(0, MAX_WIKI_SUMMARY_LENGTH) : undefined;
}
