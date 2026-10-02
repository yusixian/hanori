/** Extensible source names; identity and permissions belong to the bound provider, never input. */
export type SearchScope = string;
export type SearchStatus =
  | "ok"
  | "empty"
  | "unavailable"
  | "forbidden"
  | "rate_limited"
  | "upstream_error"
  | "invalid_request";
export type SearchFieldValue = string | number | boolean | null | readonly string[];
export interface SearchRequest {
  scope: SearchScope;
  provider?: string;
  query: string;
  page: number;
  limit: number;
  filters?: Readonly<Record<string, string | number | boolean>>;
}
export interface SearchItem {
  id: string;
  title: string;
  summary: string;
  url?: string;
  reference: string;
  source: string;
  provider: string;
  fields?: Readonly<Record<string, SearchFieldValue>>;
}
export interface SearchResult {
  status: SearchStatus;
  items: SearchItem[];
  page: number;
  limit: number;
  hasMore: boolean;
  /** True when an upstream single-page result was clipped; requesting page 2 is unsupported. */
  truncated?: boolean;
  message?: string;
  availableProviders?: readonly string[];
}
export interface SearchReferenceRequest {
  reference: string;
  offset?: number;
  limit?: number;
}
export interface SearchReferenceResult {
  status: SearchStatus;
  reference: string;
  content: string;
  offset: number;
  nextOffset?: number;
  hasMore: boolean;
  truncated?: boolean;
  source?: string;
  provider?: string;
  id?: string;
}
export interface SearchFilterDefinition {
  type: "string" | "number" | "boolean";
  description: string;
  required?: boolean;
  values?: readonly string[];
  maxLength?: number;
}
/** Provider-only body is retained in bounded, turn-local storage, never returned by search. */
export interface SearchProviderItem {
  id: string;
  title: string;
  summary: string;
  url?: string;
  content?: string;
  source?: string;
  fields?: Readonly<Record<string, SearchFieldValue>>;
}
export interface SearchProviderResult {
  status: SearchStatus;
  items: readonly SearchProviderItem[];
  hasMore: boolean;
  truncated?: boolean;
}
export interface SearchProvider {
  id: string;
  scope: SearchScope;
  description: string;
  pagination: "native" | "single_page";
  maxQueryLength?: number;
  /** Explicitly allow browsing without keywords; omitted providers require a nonempty query. */
  allowEmptyQuery?: boolean;
  filters?: Readonly<Record<string, SearchFilterDefinition>>;
  search(request: SearchRequest, signal: AbortSignal): Promise<SearchProviderResult>;
}
export type ReadonlySearchProviderRegistry = readonly SearchProvider[];
