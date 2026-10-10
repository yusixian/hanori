import Parser from "rss-parser";

/** Keep rss-parser's decoding and redirects, but own every request in the fetch. */
export async function fetchRssFeed(url: string, timeoutMs = 15_000) {
  const controller = new AbortController();
  const parser = new Parser({ timeout: timeoutMs, requestOptions: { signal: controller.signal } });
  try {
    return await parser.parseURL(url);
  } finally {
    // rss-parser rejects timeouts/status errors without destroying their HTTP requests.
    // Redirects inherit this signal, including intermediate responses left unread.
    controller.abort();
  }
}
