import { lookup } from "node:dns/promises";
import { createHash } from "node:crypto";
import { open, unlink, type FileHandle } from "node:fs/promises";
import { validateHeaderValue, type IncomingMessage } from "node:http";
import { request as httpsRequest } from "node:https";
import { BlockList, isIP } from "node:net";
import { isAbsolute } from "node:path";

export type MediaHttpFailure =
  | "invalid_request"
  | "forbidden"
  | "rate_limited"
  | "unavailable"
  | "upstream_error"
  | "too_large"
  | "invalid_content"
  | "timeout";

export class MediaHttpError extends Error {
  constructor(readonly code: MediaHttpFailure) {
    super(`Media request failed: ${code}`);
    this.name = "MediaHttpError";
  }
}

export interface MediaHttpPolicy {
  /** Exact hostnames from trusted platform code, never from model/user request parameters. */
  allowedHosts: readonly string[];
  timeoutMs?: number;
  maxRedirects?: number;
  signal?: AbortSignal;
}

export interface MediaDocumentPolicy extends MediaHttpPolicy {
  mimeTypes: readonly string[];
  maxBytes?: number;
  /** Only sent to the initial origin; permanently removed after a cross-origin redirect. */
  credential?: { origin: string; cookie?: string; authorization?: string };
}

export interface MediaDownloadPolicy extends MediaDocumentPolicy {
  /** Public platform referer only; callers cannot supply arbitrary request headers. */
  referer?: "https://www.bilibili.com/";
  /** Cumulative bytes, awaited before writing each chunk so the host can enforce disk budgets. */
  onProgress?: (bytes: number) => Promise<void>;
}

const REDIRECTS = new Set([301, 302, 303, 307, 308]);
const MAX_DOCUMENT_BYTES = 8 * 1024 * 1024;
const HOST = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;
const UNSAFE_URL_CHARACTERS = /[\s\\]/u;
const specialAddresses = new BlockList();
specialAddresses.addAddress("168.63.129.16", "ipv4");
for (const [address, prefix] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.88.99.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
] as const)
  specialAddresses.addSubnet(address, prefix, "ipv4");
// Public media hosts do not need special-use or transition IPv6 address space.
for (const [address, prefix] of [
  ["2001::", 23],
  ["2001:db8::", 32],
  ["2002::", 16],
  ["3fff::", 20],
] as const)
  specialAddresses.addSubnet(address, prefix, "ipv6");
const globalV6 = new BlockList();
globalV6.addSubnet("2000::", 3, "ipv6");

/** Fail closed for nonpublic, mapped, transition and reserved addresses (IANA registries). */
export function isPublicMediaAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) return !specialAddresses.check(address, "ipv4");
  if (family !== 6 || address.includes("%")) return false;
  return globalV6.check(address, "ipv6") && !specialAddresses.check(address, "ipv6");
}

function allowedUrl(value: string, hosts: ReadonlySet<string>, base?: URL): URL {
  try {
    if (!value || value.length > 4_096 || UNSAFE_URL_CHARACTERS.test(value)) throw new Error();
    for (const character of value) {
      const code = character.charCodeAt(0);
      if (code < 0x20 || code === 0x7f) throw new Error();
    }
    const url = base ? new URL(value, base) : new URL(value);
    if (
      url.href.length > 4_096 ||
      url.protocol !== "https:" ||
      url.username ||
      url.password ||
      url.port ||
      !hosts.has(url.hostname) ||
      isIP(url.hostname.replace(/^\[|\]$/g, ""))
    )
      throw new Error();
    return url;
  } catch {
    throw new MediaHttpError("invalid_request");
  }
}

function boundedInteger(value: number, min: number, max: number): number {
  if (!Number.isSafeInteger(value) || value < min || value > max)
    throw new MediaHttpError("invalid_request");
  return value;
}

async function abortable<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason);
    operation.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
    if (signal.aborted) abort();
    else signal.addEventListener("abort", abort, { once: true });
  });
}

async function resolveAddress(url: URL, signal: AbortSignal) {
  const addresses = await abortable(lookup(url.hostname, { all: true, verbatim: true }), signal);
  signal.throwIfAborted();
  if (!addresses.length || addresses.some(({ address }) => !isPublicMediaAddress(address)))
    throw new MediaHttpError("forbidden");
  return addresses[0]!;
}

function requestPinned(
  url: URL,
  address: { address: string; family: number },
  headers: Record<string, string>,
  signal: AbortSignal,
  method = "GET",
  body?: Buffer,
): Promise<IncomingMessage> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const request = httpsRequest(
      {
        hostname: url.hostname,
        servername: url.hostname,
        port: 443,
        path: `${url.pathname}${url.search}`,
        method,
        agent: false,
        maxHeaderSize: 16_384,
        headers,
        signal,
        // Keep TLS/Host bound to the original hostname, but prevent a second DNS lookup.
        lookup: (_hostname, options, callback) => {
          if (typeof options === "object" && options.all) callback(null, [address]);
          else callback(null, address.address, address.family);
        },
      },
      resolve,
    );
    request.once("error", reject);
    request.end(body);
  });
}

function credentialHeaders(policy: MediaDocumentPolicy, initial: URL): Record<string, string> {
  if (!policy.credential) return {};
  const { origin, cookie, authorization } = policy.credential;
  if (origin !== initial.origin) throw new MediaHttpError("invalid_request");
  const headers: Record<string, string> = {};
  for (const [name, value] of [
    ["Cookie", cookie],
    ["Authorization", authorization],
  ] as const) {
    if (!value) continue;
    try {
      if (value.length > 16_384) throw new Error();
      validateHeaderValue(name, value);
    } catch {
      throw new MediaHttpError("invalid_request");
    }
    headers[name] = value;
  }
  return headers;
}

function assertStatus(status: number): void {
  if (status >= 200 && status < 300) return;
  throw new MediaHttpError(
    status === 401 || status === 403
      ? "forbidden"
      : status === 429
        ? "rate_limited"
        : status === 404 || status === 410
          ? "unavailable"
          : "upstream_error",
  );
}

async function boundedBody(response: IncomingMessage, maxBytes: number): Promise<Buffer> {
  const declared = declaredLength(response, maxBytes);
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const value of response) {
    const chunk: Buffer = Buffer.isBuffer(value) ? value : Buffer.from(value);
    size += chunk.byteLength;
    if (size > maxBytes) throw new MediaHttpError("too_large");
    chunks.push(chunk);
  }
  if (!size || (declared !== undefined && declared !== size))
    throw new MediaHttpError("invalid_content");
  return Buffer.concat(chunks, size);
}

function declaredLength(response: IncomingMessage, maxBytes: number): number | undefined {
  const value = response.headers["content-length"];
  if (value === undefined) return undefined;
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value)))
    throw new MediaHttpError("invalid_content");
  const size = Number(value);
  if (size > maxBytes) throw new MediaHttpError("too_large");
  return size;
}

function documentMime(response: IncomingMessage, mimeTypes: readonly string[]): string {
  const mimeType = response.headers["content-type"]?.split(";", 1)[0]?.trim().toLowerCase();
  if (!mimeType || !mimeTypes.includes(mimeType)) throw new MediaHttpError("invalid_content");
  const encoding = response.headers["content-encoding"];
  if (encoding && encoding.toLowerCase() !== "identity")
    throw new MediaHttpError("invalid_content");
  return mimeType;
}

async function withResponse<T>(
  input: string,
  policy: MediaHttpPolicy,
  credential: MediaDocumentPolicy["credential"],
  consume: (response: IncomingMessage, url: URL, signal: AbortSignal) => Promise<T>,
  options: {
    method?: "POST";
    body?: Buffer;
    headers?: Record<string, string>;
    maxTimeoutMs?: number;
    defaultTimeoutMs?: number;
  } = {},
): Promise<T> {
  const hosts = new Set(policy.allowedHosts);
  if (!hosts.size || hosts.size > 64 || [...hosts].some((host) => !HOST.test(host)))
    throw new MediaHttpError("invalid_request");
  let url = allowedUrl(input, hosts);
  let sensitive = credentialHeaders({ ...policy, mimeTypes: [], credential }, url);
  const timeoutMs = boundedInteger(
    policy.timeoutMs ?? options.defaultTimeoutMs ?? 15_000,
    1,
    options.maxTimeoutMs ?? 60_000,
  );
  const maxRedirects = boundedInteger(policy.maxRedirects ?? 3, 0, 5);
  const timeout = new AbortController();
  const timer = setTimeout(() => timeout.abort(new MediaHttpError("timeout")), timeoutMs);
  timer.unref();
  const signal = policy.signal ? AbortSignal.any([policy.signal, timeout.signal]) : timeout.signal;
  try {
    for (let redirects = 0; redirects <= maxRedirects; redirects++) {
      signal.throwIfAborted();
      const address = await resolveAddress(url, signal);
      const response = await requestPinned(
        url,
        address,
        {
          "User-Agent": "Hanori-Media/1",
          "Accept-Encoding": "identity",
          ...sensitive,
          ...options.headers,
        },
        signal,
        options.method,
        options.body,
      );
      try {
        signal.throwIfAborted();
        const status = response.statusCode ?? 0;
        if (REDIRECTS.has(status)) {
          const location = response.headers.location;
          if (!location || redirects === maxRedirects) throw new MediaHttpError("upstream_error");
          const next = allowedUrl(location, hosts, url);
          if (next.origin !== url.origin) sensitive = {};
          url = next;
          continue;
        }
        assertStatus(status);
        const result = await consume(response, url, signal);
        signal.throwIfAborted();
        return result;
      } finally {
        response.destroy();
      }
    }
    throw new MediaHttpError("upstream_error");
  } catch (error) {
    signal.throwIfAborted();
    if (error instanceof MediaHttpError) throw error;
    // Do not carry upstream messages, signed URLs, headers or credentials into logs.
    throw new MediaHttpError("upstream_error");
  } finally {
    clearTimeout(timer);
  }
}

/** Resolve a short URL without retaining its HTML, cookies or response headers. */
export function resolveMediaUrl(input: string, policy: MediaHttpPolicy): Promise<string> {
  return withResponse(input, policy, undefined, async (_response, url) => url.href);
}

/** For bounded metadata/subtitle documents. Audio conversion runs in a network-free worker. */
export async function readMediaDocument(input: string, policy: MediaDocumentPolicy) {
  const maxBytes = boundedInteger(policy.maxBytes ?? 2 * 1024 * 1024, 1, MAX_DOCUMENT_BYTES);
  if (
    !policy.mimeTypes.length ||
    policy.mimeTypes.some((mime) => !/^[a-z0-9.+-]+\/[a-z0-9.+-]+$/.test(mime))
  )
    throw new MediaHttpError("invalid_request");
  return withResponse(input, policy, policy.credential, async (response, url, signal) => {
    const mimeType = documentMime(response, policy.mimeTypes);
    const bytes = await abortable(boundedBody(response, maxBytes), signal);
    return { url: url.href, mimeType, bytes };
  });
}

/** A trusted host supplies the destination path. Never overwrite an existing file or accept
 * model-supplied paths. The network-free worker receives this bounded download for conversion.
 */
export async function downloadMediaFile(
  input: string,
  policy: MediaDownloadPolicy,
  filePath: string,
): Promise<{ bytes: number; sha256: string; mimeType: string }> {
  const maxBytes = boundedInteger(policy.maxBytes ?? 64 * 1024 * 1024, 12, 64 * 1024 * 1024);
  if (
    !isAbsolute(filePath) ||
    (policy.referer !== undefined && policy.referer !== "https://www.bilibili.com/") ||
    !policy.mimeTypes.length ||
    policy.mimeTypes.some(
      (mime) => !["audio/mp4", "video/mp4", "application/octet-stream"].includes(mime),
    )
  )
    throw new MediaHttpError("invalid_request");
  let file: FileHandle | undefined;
  let created = false;
  try {
    return await withResponse(
      input,
      policy,
      policy.credential,
      async (response, _url, signal) => {
        const mimeType = documentMime(response, policy.mimeTypes);
        const declared = declaredLength(response, maxBytes);
        signal.throwIfAborted();
        file = await open(filePath, "wx", 0o600);
        created = true;
        const stat = await file.stat();
        if (!stat.isFile() || stat.nlink !== 1) throw new MediaHttpError("invalid_content");
        const hash = createHash("sha256");
        let size = 0;
        let magic = Buffer.alloc(0);
        const abort = () => response.destroy(new MediaHttpError("timeout"));
        signal.addEventListener("abort", abort, { once: true });
        try {
          signal.throwIfAborted();
          for await (const value of response) {
            signal.throwIfAborted();
            const chunk: Buffer = Buffer.isBuffer(value) ? value : Buffer.from(value);
            size += chunk.length;
            if (size > maxBytes) throw new MediaHttpError("too_large");
            if (magic.length < 12) {
              magic = Buffer.concat([magic, chunk.subarray(0, 12 - magic.length)]);
              if (
                magic.length === 12 &&
                (!magic.subarray(4, 8).equals(Buffer.from("ftyp")) || magic.readUInt32BE(0) < 12)
              )
                throw new MediaHttpError("invalid_content");
            }
            await policy.onProgress?.(size);
            signal.throwIfAborted();
            await file.writeFile(chunk);
            hash.update(chunk);
          }
          signal.throwIfAborted();
          if (magic.length < 12 || (declared !== undefined && declared !== size))
            throw new MediaHttpError("invalid_content");
          await file.close();
          file = undefined;
          return { bytes: size, sha256: hash.digest("hex"), mimeType };
        } finally {
          signal.removeEventListener("abort", abort);
        }
      },
      {
        maxTimeoutMs: 120_000,
        defaultTimeoutMs: 120_000,
        ...(policy.referer ? { headers: { Referer: "https://www.bilibili.com/" } } : {}),
      },
    );
  } catch (error) {
    if (file) await file.close().catch(() => undefined);
    if (created) await unlink(filePath).catch(() => undefined);
    throw error;
  }
}

/** Bounded ASR upload to a single configured origin. No redirects, cookies, retries or fallback. */
export async function sendMediaDocument(
  input: string,
  policy: Omit<MediaDocumentPolicy, "maxRedirects">,
  body: { contentType: string; bytes: Buffer },
) {
  const maxBytes = boundedInteger(policy.maxBytes ?? 2 * 1024 * 1024, 1, 2 * 1024 * 1024);
  if (
    policy.allowedHosts.length !== 1 ||
    policy.mimeTypes.length !== 1 ||
    policy.mimeTypes[0] !== "application/json" ||
    policy.credential?.cookie ||
    !Buffer.isBuffer(body.bytes) ||
    !body.bytes.length ||
    body.bytes.length > 21 * 1024 * 1024 ||
    !/^multipart\/form-data; boundary=[A-Za-z0-9_-]{1,70}$/.test(body.contentType)
  )
    throw new MediaHttpError("invalid_request");
  const url = allowedUrl(input, new Set(policy.allowedHosts));
  if (url.search || url.hash || /[?#]/.test(input)) throw new MediaHttpError("invalid_request");
  return withResponse(
    input,
    { ...policy, maxRedirects: 0 },
    policy.credential,
    async (response, responseUrl, signal) => {
      const mimeType = documentMime(response, policy.mimeTypes);
      const bytes = await abortable(boundedBody(response, maxBytes), signal);
      return { url: responseUrl.href, mimeType, bytes };
    },
    {
      method: "POST",
      body: body.bytes,
      headers: { "Content-Type": body.contentType, "Content-Length": String(body.bytes.length) },
      maxTimeoutMs: 180_000,
      defaultTimeoutMs: 180_000,
    },
  );
}
