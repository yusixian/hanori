import type { TimeoutConfig, WebToolsConfig } from "@cos-tool-bot/shared";
import { DEFAULT_TIMEOUT_CONFIG } from "@cos-tool-bot/shared";
import type { Tool } from "ai";
import { tool } from "ai";
import { z } from "zod";
import { zodToAiSchema } from "./utils.js";

// --- Search Provider abstraction ---

interface SearchResult {
  title: string;
  url: string;
  snippet: string;
}

interface SearchProvider {
  search(query: string, limit?: number, timeoutMs?: number): Promise<SearchResult[]>;
}

class TavilyProvider implements SearchProvider {
  constructor(private apiKey: string) {}

  async search(query: string, limit = 5, timeoutMs?: number): Promise<SearchResult[]> {
    const res = await fetch("https://api.tavily.com/search", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        api_key: this.apiKey,
        query,
        max_results: limit,
        search_depth: "basic",
      }),
      signal: AbortSignal.timeout(timeoutMs ?? DEFAULT_TIMEOUT_CONFIG.searchMs),
    });
    if (!res.ok) throw new Error(`Tavily search failed: HTTP ${res.status}`);
    const data = (await res.json()) as {
      results: Array<{ title: string; url: string; content: string }>;
    };
    return data.results.map((r) => ({ title: r.title, url: r.url, snippet: r.content }));
  }
}

class SearXNGProvider implements SearchProvider {
  constructor(private baseURL: string) {}

  async search(query: string, limit = 5, timeoutMs?: number): Promise<SearchResult[]> {
    const url = `${this.baseURL.replace(/\/+$/, "")}/search?q=${encodeURIComponent(query)}&format=json&number_of_results=${limit}`;
    const res = await fetch(url, {
      signal: AbortSignal.timeout(timeoutMs ?? DEFAULT_TIMEOUT_CONFIG.searchMs),
    });
    if (!res.ok) throw new Error(`SearXNG search failed: HTTP ${res.status}`);
    const data = (await res.json()) as {
      results: Array<{ title: string; url: string; content: string }>;
    };
    return data.results
      .slice(0, limit)
      .map((r) => ({ title: r.title, url: r.url, snippet: r.content }));
  }
}

class BraveSearchProvider implements SearchProvider {
  constructor(private apiKey: string) {}

  async search(query: string, limit = 5, timeoutMs?: number): Promise<SearchResult[]> {
    const url = `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=${limit}`;
    const res = await fetch(url, {
      headers: {
        "X-Subscription-Token": this.apiKey,
        Accept: "application/json",
        "Accept-Encoding": "gzip",
      },
      signal: AbortSignal.timeout(timeoutMs ?? DEFAULT_TIMEOUT_CONFIG.searchMs),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`Brave Search failed: HTTP ${res.status} ${text}`);
    }
    const data = (await res.json()) as Record<string, unknown>;
    if (!data.web) {
      throw new Error(`Brave Search returned no results: ${JSON.stringify(data).slice(0, 200)}`);
    }
    const web = data.web as { results: Array<{ title: string; url: string; description: string }> };
    return (web.results ?? []).slice(0, limit).map((r) => ({
      title: r.title,
      url: r.url,
      snippet: r.description,
    }));
  }
}

class CustomSearchProvider implements SearchProvider {
  constructor(
    private baseURL: string,
    private apiKey?: string,
  ) {}

  async search(query: string, limit = 5, timeoutMs?: number): Promise<SearchResult[]> {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (this.apiKey) headers["Authorization"] = `Bearer ${this.apiKey}`;
    const res = await fetch(`${this.baseURL.replace(/\/+$/, "")}/search`, {
      method: "POST",
      headers,
      body: JSON.stringify({ query, limit }),
      signal: AbortSignal.timeout(timeoutMs ?? DEFAULT_TIMEOUT_CONFIG.searchMs),
    });
    if (!res.ok) throw new Error(`Custom search failed: HTTP ${res.status}`);
    const data = (await res.json()) as { results: SearchResult[] };
    return data.results.slice(0, limit);
  }
}

function createSearchProvider(config: NonNullable<WebToolsConfig["search"]>): SearchProvider {
  switch (config.provider) {
    case "tavily":
      if (!config.apiKey) throw new Error("Tavily requires apiKey");
      return new TavilyProvider(config.apiKey);
    case "searxng":
      if (!config.baseURL) throw new Error("SearXNG requires baseURL");
      return new SearXNGProvider(config.baseURL);
    case "brave":
      if (!config.apiKey) throw new Error("Brave Search requires apiKey");
      return new BraveSearchProvider(config.apiKey);
    case "custom":
      if (!config.baseURL) throw new Error("Custom search requires baseURL");
      return new CustomSearchProvider(config.baseURL, config.apiKey);
  }
}

// --- URL validation (SSRF protection) ---

function isPrivateUrl(urlStr: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(urlStr);
  } catch {
    return true; // Reject unparseable URLs
  }

  // Only allow http(s)
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return true;

  const hostname = parsed.hostname.toLowerCase();

  // Block localhost
  if (hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1") return true;

  // Block private/reserved IP ranges
  const ipv4Match = hostname.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  if (ipv4Match) {
    const [, a, b] = ipv4Match.map(Number) as [number, number, number, number, number];
    if (a === 10) return true; // 10.0.0.0/8
    if (a === 172 && b! >= 16 && b! <= 31) return true; // 172.16.0.0/12
    if (a === 192 && b === 168) return true; // 192.168.0.0/16
    if (a === 169 && b === 254) return true; // 169.254.0.0/16 (link-local / cloud metadata)
    if (a === 0) return true; // 0.0.0.0/8
  }

  // Block IPv6 private/link-local (simplified)
  if (hostname.startsWith("[") || hostname.includes(":")) return true;

  return false;
}

// --- HTML content extraction ---

const MAX_CONTENT_LENGTH = 4000;
const MAX_HTML_SIZE = 2 * 1024 * 1024; // 2MB

async function extractPageContent(
  url: string,
  timeoutMs?: number,
): Promise<{ title: string; content: string; url: string }> {
  if (isPrivateUrl(url)) {
    throw new Error("Access to private/internal URLs is not allowed");
  }

  const res = await fetch(url, {
    headers: {
      "User-Agent": "Mozilla/5.0 (compatible; CosToolBot/1.0; +https://github.com/cos-tool-bot)",
      Accept: "text/html,application/xhtml+xml",
    },
    signal: AbortSignal.timeout(timeoutMs ?? DEFAULT_TIMEOUT_CONFIG.fetchPageMs),
  });
  if (!res.ok) throw new Error(`Fetch failed: HTTP ${res.status}`);

  const contentLength = Number(res.headers.get("content-length") || 0);
  if (contentLength > MAX_HTML_SIZE) {
    throw new Error(`Page too large: ${contentLength} bytes (max ${MAX_HTML_SIZE})`);
  }

  const html = (await res.text()).slice(0, MAX_HTML_SIZE);

  // Simple extraction: get title and main content text
  const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  const title = titleMatch ? titleMatch[1]!.trim().replace(/\s+/g, " ") : url;

  // Try to extract article/main content, fall back to body
  let contentHtml = "";
  const articleMatch = html.match(/<article[^>]*>([\s\S]*?)<\/article>/i);
  const mainMatch = html.match(/<main[^>]*>([\s\S]*?)<\/main>/i);
  if (articleMatch) {
    contentHtml = articleMatch[1]!;
  } else if (mainMatch) {
    contentHtml = mainMatch[1]!;
  } else {
    const bodyMatch = html.match(/<body[^>]*>([\s\S]*?)<\/body>/i);
    contentHtml = bodyMatch ? bodyMatch[1]! : html;
  }

  // Strip tags and clean up whitespace
  const text = contentHtml
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "")
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "")
    .replace(/<nav[^>]*>[\s\S]*?<\/nav>/gi, "")
    .replace(/<footer[^>]*>[\s\S]*?<\/footer>/gi, "")
    .replace(/<header[^>]*>[\s\S]*?<\/header>/gi, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, " ")
    .trim();

  const content =
    text.length > MAX_CONTENT_LENGTH ? text.slice(0, MAX_CONTENT_LENGTH) + "..." : text;

  return { title, content, url };
}

// --- Tool factory ---

export interface WebToolsOptions {
  config: WebToolsConfig;
  timeoutConfig?: TimeoutConfig;
}

export function createWebTools(options: WebToolsOptions): Record<string, Tool> {
  const { config, timeoutConfig } = options;
  const searchMs = timeoutConfig?.searchMs ?? DEFAULT_TIMEOUT_CONFIG.searchMs;
  const fetchPageMs = timeoutConfig?.fetchPageMs ?? DEFAULT_TIMEOUT_CONFIG.fetchPageMs;
  const tools: Record<string, Tool> = {};

  // Always include get_current_time
  tools.get_current_time = tool({
    description: "获取当前时间。可指定时区（默认 Asia/Shanghai）。",
    inputSchema: zodToAiSchema(
      z.object({
        timezone: z.string().optional().describe("时区名称，如 Asia/Shanghai, America/New_York"),
      }),
    ),
    execute: async ({ timezone }) => {
      const tz = timezone || "Asia/Shanghai";
      try {
        const now = new Date();
        const formatted = now.toLocaleString("zh-CN", { timeZone: tz });
        return { time: formatted, timezone: tz, iso: now.toISOString() };
      } catch {
        return { error: `无效的时区: ${tz}` };
      }
    },
  });

  // Search tool
  if (config.search) {
    try {
      const searchProvider = createSearchProvider(config.search);
      tools.web_search = tool({
        description: "搜索网络获取最新信息。返回搜索结果的标题、URL 和摘要。",
        inputSchema: zodToAiSchema(
          z.object({
            query: z.string().describe("搜索关键词"),
            limit: z.number().min(1).max(10).optional().describe("返回结果数量，默认 5"),
          }),
        ),
        execute: async ({ query, limit }) => {
          try {
            const results = await searchProvider.search(query, limit ?? 5, searchMs);
            return { count: results.length, results };
          } catch (err) {
            return { error: String(err) };
          }
        },
      });
    } catch {
      // Search provider config invalid, skip
    }
  }

  // Fetch webpage tool (always available when web tools enabled)
  tools.fetch_webpage = tool({
    description: "获取网页正文内容。用于深入阅读搜索结果中的页面。内容会被截断到约 4000 字符。",
    inputSchema: zodToAiSchema(
      z.object({
        url: z.string().describe("要获取内容的网页 URL"),
      }),
    ),
    execute: async ({ url }) => {
      try {
        return await extractPageContent(url, fetchPageMs);
      } catch (err) {
        return { error: String(err) };
      }
    },
  });

  return tools;
}
