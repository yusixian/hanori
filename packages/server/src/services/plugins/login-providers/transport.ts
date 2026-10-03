import { lookup } from "node:dns/promises";
import { request } from "node:https";
import type { IncomingMessage } from "node:http";
import { CookieJar } from "tough-cookie";
import { isPublicMediaAddress } from "../../media/http.js";

export class LoginProviderError extends Error {
  constructor(readonly code: "unavailable" | "invalid_response" | "cancelled" | "rate_limited") {
    super(`Plugin login failed: ${code}`);
    this.name = "LoginProviderError";
  }
}

const MAX_BYTES = 128 * 1024;
const MAX_COOKIES = 64;
const MAX_COOKIE_BYTES = 16_384;
const REDIRECTS = new Set([301, 302, 303, 307, 308]);
const BILI_PATHS: Record<string, readonly string[]> = {
  "https://passport.bilibili.com": [
    "/x/passport-login/web/qrcode/generate",
    "/x/passport-login/web/qrcode/poll",
    "/x/passport-login/web/crossDomain",
  ],
  "https://passport.biligame.com": ["/x/passport-login/web/crossDomain"],
  "https://www.bilibili.com": ["/"],
  "https://api.bilibili.com": ["/x/web-interface/nav"],
};
const NETEASE_PATHS = [
  "/weapi/login/qrcode/unikey",
  "/weapi/login/qrcode/client/login",
  "/weapi/w/nuser/account/get",
];

function hasControlCharacters(value: string): boolean {
  return [...value].some(
    (character) => character.charCodeAt(0) < 0x20 || character.charCodeAt(0) === 0x7f,
  );
}

function allowedUrl(value: string, platform: "bilibili" | "netease", redirect: boolean): URL {
  try {
    if (value.length > 4_096 || /[\s\\]/u.test(value) || hasControlCharacters(value))
      throw new Error();
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username || url.password || url.port || url.hash)
      throw new Error();
    if (platform === "netease") {
      if (
        url.origin !== "https://music.163.com" ||
        !NETEASE_PATHS.includes(url.pathname) ||
        url.search
      )
        throw new Error();
    } else {
      if (!BILI_PATHS[url.origin]?.includes(url.pathname)) throw new Error();
      if (
        redirect &&
        url.pathname !== "/x/passport-login/web/crossDomain" &&
        url.href !== "https://www.bilibili.com/"
      )
        throw new Error();
      const keys = [...url.searchParams.keys()];
      if (url.pathname.endsWith("/poll")) {
        if (
          keys.length !== 1 ||
          keys[0] !== "qrcode_key" ||
          !/^[a-f0-9]{32}$/i.test(url.searchParams.get("qrcode_key") ?? "")
        )
          throw new Error();
      } else if (url.pathname.endsWith("/crossDomain")) {
        if (
          keys.length !== 1 ||
          keys[0] !== "ticket" ||
          !/^[A-Za-z0-9_~.+/=-]{1,2048}$/.test(url.searchParams.get("ticket") ?? "")
        )
          throw new Error();
      } else if (keys.length) throw new Error();
    }
    return url;
  } catch {
    throw new LoginProviderError("invalid_response");
  }
}

async function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const aborted = () => reject(new LoginProviderError("cancelled"));
    signal.addEventListener("abort", aborted, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", aborted));
  });
}

async function pinnedRequest(
  url: URL,
  method: "GET" | "POST",
  headers: Record<string, string>,
  body: string | undefined,
  signal: AbortSignal,
): Promise<IncomingMessage> {
  const addresses = await abortable(lookup(url.hostname, { all: true, verbatim: true }), signal);
  if (!addresses.length || addresses.some(({ address }) => !isPublicMediaAddress(address)))
    throw new LoginProviderError("unavailable");
  const address = addresses[0]!;
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const req = request(
      {
        hostname: url.hostname,
        servername: url.hostname,
        port: 443,
        path: `${url.pathname}${url.search}`,
        method,
        agent: false,
        maxHeaderSize: 16_384,
        signal,
        headers,
        lookup: (_hostname, options, callback) => {
          if (typeof options === "object" && options.all) callback(null, [address]);
          else callback(null, address.address, address.family);
        },
      },
      resolve,
    );
    req.once("error", reject);
    req.end(body);
  });
}

/** One private, bounded, domain-aware jar per attempt; never promoted across platform domains. */
export class LoginTransport {
  private readonly jar = new CookieJar(undefined, { prefixSecurity: "strict" });
  private readonly controller = new AbortController();

  constructor(
    private readonly platform: "bilibili" | "netease",
    private readonly lifetime: AbortSignal,
  ) {}

  dispose(): void {
    this.controller.abort();
    this.jar.removeAllCookiesSync();
  }

  cookieFor(url: string): string {
    this.lifetime.throwIfAborted();
    this.controller.signal.throwIfAborted();
    const target =
      this.platform === "bilibili" ? "https://api.bilibili.com/" : "https://music.163.com/";
    if (url !== target) throw new LoginProviderError("invalid_response");
    return this.jar.getCookieStringSync(url);
  }

  async json(url: string, signal: AbortSignal, body?: string): Promise<Record<string, unknown>> {
    const bytes = await this.fetch(url, signal, body, false);
    try {
      const value: unknown = JSON.parse(bytes.toString("utf8"));
      if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error();
      return value as Record<string, unknown>;
    } catch {
      throw new LoginProviderError("invalid_response");
    }
  }

  async follow(url: string, signal: AbortSignal): Promise<void> {
    const initial = allowedUrl(url, this.platform, true);
    signal.throwIfAborted();
    this.lifetime.throwIfAborted();
    this.controller.signal.throwIfAborted();
    // The browser's terminal navigation carries no new login ticket. Verify nav instead
    // of downloading an unrelated, potentially large/compressed homepage.
    if (initial.href === "https://www.bilibili.com/") return;
    await this.fetch(url, signal, undefined, true);
  }

  private async fetch(
    input: string,
    externalSignal: AbortSignal,
    body: string | undefined,
    redirects: boolean,
  ): Promise<Buffer> {
    const signal = AbortSignal.any([
      this.lifetime,
      this.controller.signal,
      externalSignal,
      AbortSignal.timeout(15_000),
    ]);
    try {
      signal.throwIfAborted();
      if (
        (this.platform === "netease") !== (body !== undefined) ||
        (body !== undefined && Buffer.byteLength(body) > 16_384)
      )
        throw new LoginProviderError("invalid_response");
      let url = allowedUrl(input, this.platform, false);
      for (let hop = 0; hop <= 3; hop++) {
        const cookie = this.jar.getCookieStringSync(url.href);
        const headers: Record<string, string> = {
          "User-Agent":
            "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
          Accept: "application/json, text/plain, */*",
          "Accept-Encoding": "identity",
          Referer:
            this.platform === "bilibili"
              ? "https://passport.bilibili.com/"
              : "https://music.163.com/",
        };
        if (cookie) headers.Cookie = cookie;
        if (body !== undefined) {
          headers["Content-Type"] = "application/x-www-form-urlencoded";
          headers["Content-Length"] = String(Buffer.byteLength(body));
        }
        const response = await pinnedRequest(
          url,
          body === undefined ? "GET" : "POST",
          headers,
          body,
          signal,
        );
        try {
          const status = response.statusCode ?? 0;
          if (status === 429) throw new LoginProviderError("rate_limited");
          if (!REDIRECTS.has(status) && (status < 200 || status >= 300))
            throw new LoginProviderError("unavailable");
          const setCookies = response.headers["set-cookie"] ?? [];
          if (setCookies.length > MAX_COOKIES || setCookies.some((value) => value.length > 4_096))
            throw new LoginProviderError("invalid_response");
          for (const value of setCookies)
            this.jar.setCookieSync(value, url.href, { ignoreError: true });
          const stored = this.jar.serializeSync()?.cookies ?? [];
          if (
            stored.length > MAX_COOKIES ||
            Buffer.byteLength(JSON.stringify(stored)) > MAX_COOKIE_BYTES
          )
            throw new LoginProviderError("invalid_response");
          if (REDIRECTS.has(status)) {
            if (!redirects || hop === 3 || typeof response.headers.location !== "string")
              throw new LoginProviderError("invalid_response");
            url = allowedUrl(new URL(response.headers.location, url).href, this.platform, true);
            if (url.href === "https://www.bilibili.com/") return Buffer.alloc(0);
            continue;
          }
          if (redirects) return Buffer.alloc(0);
          const encoding = response.headers["content-encoding"];
          if (encoding && encoding !== "identity") throw new LoginProviderError("invalid_response");
          if (!/^application\/json(?:\s*;|$)/i.test(response.headers["content-type"] ?? ""))
            throw new LoginProviderError("invalid_response");
          const length = response.headers["content-length"];
          if (length !== undefined && (!/^\d+$/.test(length) || Number(length) > MAX_BYTES))
            throw new LoginProviderError("invalid_response");
          const chunks: Buffer[] = [];
          let size = 0;
          for await (const chunk of response) {
            const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
            size += bytes.byteLength;
            if (size > MAX_BYTES) throw new LoginProviderError("invalid_response");
            chunks.push(bytes);
          }
          signal.throwIfAborted();
          if (length !== undefined && Number(length) !== size)
            throw new LoginProviderError("invalid_response");
          return Buffer.concat(chunks, size);
        } finally {
          response.destroy();
        }
      }
      throw new LoginProviderError("invalid_response");
    } catch (error) {
      if (signal.aborted)
        throw new LoginProviderError(
          externalSignal.aborted || this.lifetime.aborted || this.controller.signal.aborted
            ? "cancelled"
            : "unavailable",
        );
      if (error instanceof LoginProviderError) throw error;
      throw new LoginProviderError("unavailable");
    }
  }
}

export function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new LoginProviderError("invalid_response");
  return value as Record<string, unknown>;
}

export function accountName(value: unknown): string {
  if (
    typeof value !== "string" ||
    !value.trim() ||
    value.length > 128 ||
    hasControlCharacters(value)
  )
    throw new LoginProviderError("invalid_response");
  return value;
}
