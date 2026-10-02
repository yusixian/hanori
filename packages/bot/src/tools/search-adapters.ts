import type {
  ReadonlySearchProviderRegistry,
  SearchFieldValue,
  SearchFilterDefinition,
  SearchProvider,
  SearchProviderItem,
  SearchProviderResult,
  SearchRequest,
} from "@cos-tool-bot/shared";
import type { Tool } from "ai";
import { normalizeSearchError } from "./search.js";

type Row = Record<string, unknown>;
type Adapter = {
  name: string;
  id: string;
  scope: string;
  description: string;
  pagination?: "native";
  maxQueryLength?: number;
  allowEmptyQuery?: boolean;
  filters?: Record<string, SearchFilterDefinition>;
  input(request: SearchRequest): Record<string, unknown>;
  rows(value: unknown): Row[];
  item(row: Row, index: number, request: SearchRequest): SearchProviderItem;
  matches?(row: Row, request: SearchRequest): boolean;
};
function record(value: unknown): Row {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    throw new Error("Malformed source result");
  return value as Row;
}
function text(value: unknown): string {
  return typeof value === "string" ? value : typeof value === "number" ? String(value) : "";
}
function rows(key?: string) {
  return (value: unknown): Row[] => {
    const data = key ? record(value)[key] : value;
    if (!Array.isArray(data)) throw new Error("Malformed source result");
    return data.map(record);
  };
}
function fields(row: Row, keys: string[]): Record<string, SearchFieldValue> {
  const result: Record<string, SearchFieldValue> = {};
  for (const key of keys) {
    const value = row[key];
    if (
      typeof value === "string" ||
      typeof value === "number" ||
      typeof value === "boolean" ||
      value === null
    )
      result[key] = value;
    else if (Array.isArray(value) && value.every((entry) => typeof entry === "string"))
      result[key] = value;
  }
  return result;
}
function body(row: Row, keys: string[]): string {
  return keys
    .map((key) => text(row[key]))
    .filter(Boolean)
    .join("\n\n");
}
const stringFilter = (
  description: string,
  maxLength = 200,
  required = false,
): SearchFilterDefinition => ({ type: "string", description, maxLength, required });
const enumFilter = (description: string, values: string[]): SearchFilterDefinition => ({
  type: "string",
  description,
  values,
});
const repositoryFilters = {
  repository: stringFilter("owner/repository", 200, true),
};

// This literal whitelist is the only dispatch surface. Input never selects a tool name or actor.
const adapters: readonly Adapter[] = [
  {
    name: "web_search",
    id: "builtin.web",
    scope: "web",
    description:
      "Web titles, URLs and snippets; upstream supports at most 10 results, no pagination.",
    input: (request) => ({ query: request.query, limit: Math.min(request.limit, 10) }),
    rows: rows("results"),
    item: (row) => ({
      id: text(row.url),
      title: text(row.title),
      summary: text(row.snippet),
      url: text(row.url),
      content: text(row.snippet),
    }),
  },
  {
    name: "search_history",
    id: "builtin.history",
    scope: "history",
    description:
      "History visible through this turn's bound memory service; no actor/chat overrides or pagination.",
    input: (request) => ({ query: request.query, limit: request.limit }),
    rows: rows("results"),
    item: (row, index) => ({
      id: text(row.id) || `${text(row.chatId)}:${text(row.createdAt)}:${index}`,
      title: text(row.userName) || text(row.role) || "Message",
      summary: text(row.content),
      content: text(row.content),
      fields: fields(row, ["id", "chatId", "messageId", "role", "userName", "createdAt"]),
    }),
  },
  {
    name: "search_profiles",
    id: "builtin.profiles",
    scope: "profiles",
    description:
      "People profiles visible through bound permissions; legacy source returns at most 10 profiles and supports no pagination.",
    input: (request) => ({ query: request.query }),
    rows: rows("profiles"),
    item: (row) => ({
      id: text(row.telegramId),
      title: text(row.displayName) || text(row.username) || text(row.telegramId),
      summary: body(row, ["notes", "relationship"]),
      content: body(row, ["notes", "relationship"]),
      fields: fields(row, ["telegramId", "username", "traits", "interests", "lastSeen"]),
    }),
  },
  {
    name: "recall_memories",
    id: "builtin.memory",
    scope: "memory",
    description:
      "Long-term memory already authorized for this actor/chat; scope only narrows that visible set.",
    filters: {
      category: stringFilter("Memory category", 100),
      scope: enumFilter("Subset of current visible memory", [
        "current_user",
        "chat",
        "all_visible",
      ]),
    },
    input: (request) => ({ query: request.query, limit: request.limit, ...request.filters }),
    rows: rows("memories"),
    item: (row) => ({
      id: text(row.id),
      title: text(row.category) || text(row.kind) || "Memory",
      summary: text(row.content),
      content: text(row.content),
      fields: fields(row, [
        "id",
        "category",
        "kind",
        "scopeChatId",
        "sourceMessageId",
        "sourceChatId",
        "sourceUserId",
        "factValidAt",
        "expiresAt",
      ]),
    }),
  },
  {
    name: "search_generation_characters",
    id: "builtin.characters.local",
    scope: "characters",
    description:
      "Stored characters; bind with query-hit persistence disabled for read-only search.",
    pagination: "native",
    maxQueryLength: 160,
    input: (request) => ({ search: request.query, page: request.page, limit: request.limit }),
    rows: rows("data"),
    item: (row) => ({
      id: text(row.id),
      title: text(row.name),
      summary: body(row, ["appearance", "wikiSummary"]),
      content: body(row, ["appearance", "defaultOutfit", "notes", "wikiSummary"]),
      url: text(row.sourceUrl) || undefined,
      source: text(row.source) || "local_generation_library",
      fields: fields(row, [
        "id",
        "canonicalTag",
        "aliases",
        "copyright",
        "postCount",
        "sourceFetchedAt",
      ]),
    }),
  },
  {
    name: "search_prompt_assets",
    id: "builtin.prompt_assets",
    scope: "prompt_assets",
    description:
      "Stored prompt assets visible to this actor; existing safety checks remain authoritative.",
    pagination: "native",
    allowEmptyQuery: true,
    maxQueryLength: 160,
    filters: {
      type: enumFilter("Asset type", ["artist_string", "style", "outfit", "trait", "composition"]),
      safety: enumFilter("Requested safety category", ["safe", "nsfw"]),
    },
    input: (request) => ({
      search: request.query,
      page: request.page,
      limit: request.limit,
      ...request.filters,
    }),
    rows: rows("data"),
    item: (row) => ({
      id: text(row.id),
      title: text(row.name),
      summary: text(row.content),
      content: body(row, ["content", "notes"]),
      source: "local_generation_library",
      fields: fields(row, ["id", "type", "safety", "pinned", "updatedAt"]),
    }),
  },
  {
    name: "search_danbooru_character_tags",
    id: "builtin.characters.danbooru",
    scope: "characters",
    description:
      "Danbooru tags and cached wiki summaries; bind with local persistence disabled for read-only search.",
    input: (request) => ({ query: request.query, limit: request.limit }),
    rows: rows("tags"),
    item: (row) => ({
      id: text(row.tag),
      title: text(row.label) || text(row.tag),
      summary: text(row.wikiSummary),
      content: text(row.wikiSummary),
      url: text(row.postsUrl),
      source: "danbooru",
      fields: fields(row, ["tag", "matchedAlias", "postCount", "otherNames"]),
    }),
  },
  {
    name: "github_list_issues",
    id: "builtin.github.issues",
    scope: "github",
    allowEmptyQuery: true,
    description:
      "Title filter over a bounded first issue window (up to requested limit), not full GitHub search; no pagination.",
    filters: { ...repositoryFilters, state: enumFilter("Issue state", ["open", "closed", "all"]) },
    input: (request) => ({
      repository: request.filters!.repository,
      state: request.filters?.state ?? "open",
      limit: request.limit,
    }),
    rows: rows(),
    matches: (row, request) => text(row.title).toLowerCase().includes(request.query.toLowerCase()),
    item: (row) => ({
      id: text(row.number),
      title: text(row.title),
      summary: text(row.title),
      url: text(row.url),
      fields: fields(row, ["number", "state", "author", "labels"]),
    }),
  },
  {
    name: "github_list_tree",
    id: "builtin.github.tree",
    scope: "github",
    allowEmptyQuery: true,
    description:
      "Path filter over the legacy capped repository tree; no pagination and truncation is reported.",
    filters: { ...repositoryFilters, ref: stringFilter("Branch/tag/commit", 200) },
    input: (request) => ({
      repository: request.filters!.repository,
      ...(request.filters?.ref ? { ref: request.filters.ref } : {}),
    }),
    rows: rows("entries"),
    matches: (row, request) => text(row.path).toLowerCase().includes(request.query.toLowerCase()),
    item: (row) => ({
      id: text(row.sha) || text(row.path),
      title: text(row.path),
      summary: text(row.type),
      fields: fields(row, ["path", "sha", "type", "size", "url"]),
    }),
  },
  {
    name: "fetch_artwork_info",
    id: "builtin.artwork.lookup",
    scope: "artwork",
    description:
      "Look up a supported Pixiv or X/Twitter URL supplied as query; returns metadata, never sends media.",
    input: (request) => ({ url: request.query }),
    rows: (value) => [record(value)],
    item: (row) => ({
      id:
        text(row.postId) ||
        /\/(?:artworks|status)\/(\d+)/.exec(text(row.postUrl))?.[1] ||
        text(row.postUrl),
      title: text(row.title) || "Artwork",
      summary: text(row.description),
      content: text(row.description),
      url: text(row.postUrl),
      source: text(row.platform) || "artwork",
      fields: {
        ...fields(row, ["postId", "platform", "imageCount", "tags", "isNSFW", "isAI"]),
        authorId: text(record(row.author ?? {}).id),
        authorName: text(record(row.author ?? {}).name),
        authorUsername: text(record(row.author ?? {}).username),
      },
    }),
  },
];

/**
 * Receives tools already bound to this actor's permissions and read-only settings.
 * Bind generation-library with trackSearchHits=false and Danbooru with persistSearchResults=false.
 * Missing tools stay absent; no runtime permission or installation lookup happens here.
 */
export function createBuiltinSearchProviders(
  tools: Readonly<Record<string, Tool>>,
  context?: { chatId: number },
): {
  providers: ReadonlySearchProviderRegistry;
  migratedToolNames: string[];
} {
  const providers: SearchProvider[] = [];
  const migratedToolNames: string[] = [];
  for (const adapter of adapters) {
    if (
      adapter.name === "search_history" &&
      (!context || !Number.isSafeInteger(context.chatId) || context.chatId === 0)
    )
      continue;
    const execute = tools[adapter.name]?.execute;
    if (typeof execute !== "function") continue;
    migratedToolNames.push(adapter.name);
    providers.push(
      Object.freeze({
        id: adapter.id,
        scope: adapter.scope,
        description: adapter.description,
        pagination: adapter.pagination ?? "single_page",
        maxQueryLength: adapter.maxQueryLength,
        allowEmptyQuery: adapter.allowEmptyQuery,
        filters: adapter.filters,
        search: async (
          request: SearchRequest,
          signal: AbortSignal,
        ): Promise<SearchProviderResult> => {
          signal.throwIfAborted();
          if (
            adapter.scope === "github" &&
            !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(String(request.filters?.repository ?? ""))
          )
            return { status: "invalid_request", items: [], hasMore: false };
          if (
            adapter.scope === "artwork" &&
            !/^https?:\/\/(?:www\.)?(?:pixiv\.net|x\.com|twitter\.com)\//i.test(request.query)
          )
            return { status: "invalid_request", items: [], hasMore: false };
          const mappedInput =
            adapter.name === "search_history"
              ? { ...adapter.input(request), chat_id: context!.chatId }
              : adapter.input(request);
          const value: unknown = await execute(mappedInput, {
            toolCallId: `search:${adapter.id}`,
            messages: [],
            abortSignal: signal,
          });
          signal.throwIfAborted();
          if (value && typeof value === "object" && "error" in value)
            return { status: normalizeSearchError(value.error), items: [], hasMore: false };
          const allRows = adapter.rows(value);
          const selected = adapter.matches
            ? allRows.filter((row) => adapter.matches!(row, request))
            : allRows;
          const upstream = Array.isArray(value) ? {} : record(value);
          const items = selected.slice(0, request.limit).map((row, index) => {
            const item = adapter.item(row, index, request);
            return {
              ...item,
              fields: { ...fields(upstream, ["fetchedAt", "stale", "freshness"]), ...item.fields },
            };
          });
          if (items.some((item) => !item.id || !item.title))
            throw new Error("Malformed source item");
          if (
            adapter.pagination === "native" &&
            (typeof upstream.total !== "number" ||
              !Number.isFinite(upstream.total) ||
              upstream.total < 0)
          )
            throw new Error("Malformed source pagination");
          return {
            status: items.length ? "ok" : "empty",
            items,
            hasMore:
              adapter.pagination === "native" &&
              request.page * request.limit < Number(upstream.total),
            truncated:
              upstream.truncated === true ||
              selected.length > request.limit ||
              (adapter.scope === "github" &&
                !adapter.pagination &&
                allRows.length >= request.limit &&
                adapter.name === "github_list_issues"),
          };
        },
      }),
    );
  }
  return { providers: Object.freeze(providers), migratedToolNames };
}
