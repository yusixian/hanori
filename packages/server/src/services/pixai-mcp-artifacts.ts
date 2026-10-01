import type { OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js";
import type { PixaiMcpInlineImage, PixaiMcpResourceLink } from "./pixai-mcp-client.js";

const ARTIFACT_PATH =
  /^\/api\/artifacts\/[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const DEFAULT_ALLOWED_MIME_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);

export type PixaiMcpArtifactErrorCode =
  | "INVALID_URI"
  | "UNSUPPORTED_MIME_TYPE"
  | "TOO_LARGE"
  | "AUTHORIZATION_REQUIRED"
  | "DOWNLOAD_FAILED"
  | "TOO_MANY_REDIRECTS"
  | "INVALID_INLINE_IMAGE";

export class PixaiMcpArtifactError extends Error {
  constructor(readonly code: PixaiMcpArtifactErrorCode) {
    super(messageForCode(code));
    this.name = "PixaiMcpArtifactError";
  }
}

export interface PixaiMcpArtifactData {
  bytes: Uint8Array;
  mimeType: string;
  source: "inline" | "resource_link";
  name?: string;
}

export interface PixaiMcpArtifactReaderOptions {
  endpoint: string | URL | undefined;
  authProvider: Pick<OAuthClientProvider, "tokens">;
  fetch?: typeof fetch;
  maxBytes?: number;
  timeoutMs?: number;
  maxRedirects?: number;
  allowedMimeTypes?: ReadonlySet<string>;
}

/** Safely turns MCP image blocks or protected links into bounded image bytes. */
export class PixaiMcpArtifactReader {
  private readonly origin: string | undefined;
  private readonly authProvider: Pick<OAuthClientProvider, "tokens">;
  private readonly fetchFn: typeof fetch;
  private readonly maxBytes: number;
  private readonly timeoutMs: number;
  private readonly maxRedirects: number;
  private readonly allowedMimeTypes: ReadonlySet<string>;

  constructor(options: PixaiMcpArtifactReaderOptions) {
    this.origin = options.endpoint ? new URL(options.endpoint).origin : undefined;
    this.authProvider = options.authProvider;
    this.fetchFn = options.fetch ?? fetch;
    this.maxBytes = options.maxBytes ?? 5 * 1024 * 1024;
    this.timeoutMs = options.timeoutMs ?? 15_000;
    this.maxRedirects = options.maxRedirects ?? 3;
    this.allowedMimeTypes = options.allowedMimeTypes ?? DEFAULT_ALLOWED_MIME_TYPES;
  }

  readInline(image: PixaiMcpInlineImage): PixaiMcpArtifactData {
    const mimeType = this.validateMimeType(image.mimeType);
    if (!isCanonicalBase64(image.data)) {
      throw new PixaiMcpArtifactError("INVALID_INLINE_IMAGE");
    }
    const estimatedBytes = Math.floor((image.data.length * 3) / 4);
    if (estimatedBytes > this.maxBytes + 2) throw new PixaiMcpArtifactError("TOO_LARGE");
    const bytes = Uint8Array.from(Buffer.from(image.data, "base64"));
    if (bytes.byteLength > this.maxBytes) throw new PixaiMcpArtifactError("TOO_LARGE");
    return { bytes, mimeType, source: "inline" };
  }

  async download(link: PixaiMcpResourceLink, signal?: AbortSignal): Promise<PixaiMcpArtifactData> {
    let url = this.validateArtifactUrl(link.uri);
    let tokens;
    try {
      tokens = await this.authProvider.tokens();
    } catch {
      throw new PixaiMcpArtifactError("AUTHORIZATION_REQUIRED");
    }
    if (!tokens?.access_token) throw new PixaiMcpArtifactError("AUTHORIZATION_REQUIRED");

    const timeoutSignal = AbortSignal.timeout(this.timeoutMs);
    const requestSignal = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;

    for (let redirects = 0; redirects <= this.maxRedirects; redirects++) {
      let response: Response;
      try {
        response = await this.fetchFn(url, {
          method: "GET",
          headers: { Authorization: `Bearer ${tokens.access_token}` },
          redirect: "manual",
          signal: requestSignal,
        });
      } catch {
        throw new PixaiMcpArtifactError("DOWNLOAD_FAILED");
      }

      if (isRedirect(response.status)) {
        if (redirects === this.maxRedirects) {
          throw new PixaiMcpArtifactError("TOO_MANY_REDIRECTS");
        }
        const location = response.headers.get("location");
        if (!location) throw new PixaiMcpArtifactError("DOWNLOAD_FAILED");
        url = this.validateArtifactUrl(new URL(location, url).toString());
        continue;
      }

      if (response.status === 401 || response.status === 403) {
        throw new PixaiMcpArtifactError("AUTHORIZATION_REQUIRED");
      }
      if (!response.ok) throw new PixaiMcpArtifactError("DOWNLOAD_FAILED");

      const contentLength = response.headers.get("content-length");
      if (contentLength !== null) {
        const parsedLength = Number(contentLength);
        if (!Number.isSafeInteger(parsedLength) || parsedLength < 0) {
          throw new PixaiMcpArtifactError("DOWNLOAD_FAILED");
        }
        if (parsedLength > this.maxBytes) throw new PixaiMcpArtifactError("TOO_LARGE");
      }

      const mimeType = this.validateMimeType(response.headers.get("content-type") ?? "");
      const bytes = await readBoundedBody(response, this.maxBytes);
      return { bytes, mimeType, source: "resource_link", name: link.name };
    }

    throw new PixaiMcpArtifactError("TOO_MANY_REDIRECTS");
  }

  validateArtifactUrl(value: string | URL): URL {
    let url: URL;
    try {
      url = new URL(value);
    } catch {
      throw new PixaiMcpArtifactError("INVALID_URI");
    }
    if (
      url.origin !== this.origin ||
      !ARTIFACT_PATH.test(url.pathname) ||
      url.search !== "" ||
      url.hash !== ""
    ) {
      throw new PixaiMcpArtifactError("INVALID_URI");
    }
    return url;
  }

  private validateMimeType(value: string): string {
    const mimeType = value.split(";", 1)[0]!.trim().toLowerCase();
    if (!this.allowedMimeTypes.has(mimeType)) {
      throw new PixaiMcpArtifactError("UNSUPPORTED_MIME_TYPE");
    }
    return mimeType;
  }
}

async function readBoundedBody(response: Response, maxBytes: number): Promise<Uint8Array> {
  if (!response.body) throw new PixaiMcpArtifactError("DOWNLOAD_FAILED");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        throw new PixaiMcpArtifactError("TOO_LARGE");
      }
      chunks.push(value);
    }
  } catch (error) {
    if (error instanceof PixaiMcpArtifactError) throw error;
    throw new PixaiMcpArtifactError("DOWNLOAD_FAILED");
  }

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

function isRedirect(status: number): boolean {
  return status === 301 || status === 302 || status === 303 || status === 307 || status === 308;
}

function isCanonicalBase64(value: string): boolean {
  if (value.length === 0 || value.length % 4 !== 0) return false;
  return /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value);
}

function messageForCode(code: PixaiMcpArtifactErrorCode): string {
  switch (code) {
    case "INVALID_URI":
      return "PixAI MCP artifact URI is not allowed";
    case "UNSUPPORTED_MIME_TYPE":
      return "PixAI MCP artifact MIME type is not allowed";
    case "TOO_LARGE":
      return "PixAI MCP artifact exceeds the size limit";
    case "AUTHORIZATION_REQUIRED":
      return "PixAI MCP artifact authorization is required";
    case "DOWNLOAD_FAILED":
      return "PixAI MCP artifact download failed";
    case "TOO_MANY_REDIRECTS":
      return "PixAI MCP artifact redirected too many times";
    case "INVALID_INLINE_IMAGE":
      return "PixAI MCP inline image is invalid";
  }
}
