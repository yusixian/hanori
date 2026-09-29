const API_ROOT = "https://api.github.com";
const API_VERSION = "2022-11-28";
const USER_AGENT = "cos-tool-bot";
const DEFAULT_TIMEOUT_MS = 15_000;
const MAX_MESSAGE_LENGTH = 300;

/**
 * `forbidden` is a missing permission, never a rate limit. GitHub also answers `not_found` for a
 * resource the token cannot see.
 */
export type GitHubErrorKind = "not_found" | "forbidden" | "rate_limited" | "other";

/** A non-2xx answer from the GitHub REST API. */
export class GitHubApiError extends Error {
  readonly kind: GitHubErrorKind;
  /** Only a rate limit carries one, and only when GitHub said how long to wait. */
  readonly retryAfterMs: number | null;

  constructor(
    readonly status: number,
    message: string,
    options: { rateLimited?: boolean; retryAfterMs?: number } = {},
  ) {
    super(message);
    this.name = "GitHubApiError";
    this.kind =
      options.rateLimited || status === 429
        ? "rate_limited"
        : status === 403
          ? "forbidden"
          : status === 404
            ? "not_found"
            : "other";
    this.retryAfterMs = this.kind === "rate_limited" ? (options.retryAfterMs ?? null) : null;
  }
}

export interface GitHubRequestInit {
  method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  /** JSON text. */
  body?: string;
  /** Default 15 s. */
  timeoutMs?: number;
  /** Replaces GitHub's own text as the error message, for copy a user may see. */
  failureMessage?: (status: number) => string;
}

/**
 * Sends one authenticated request to `https://api.github.com${path}` and resolves its JSON body
 * (undefined when empty). A non-2xx answer throws `GitHubApiError`; network failures and timeouts
 * reject as `fetchImpl` does.
 */
export async function githubRequest<T>(
  fetchImpl: typeof fetch,
  path: string,
  token: string,
  init: GitHubRequestInit = {},
): Promise<T> {
  const { method, body, timeoutMs = DEFAULT_TIMEOUT_MS, failureMessage } = init;
  const response = await fetchImpl(`${API_ROOT}${path}`, {
    method,
    body,
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${token}`,
      "User-Agent": USER_AGENT,
      "X-GitHub-Api-Version": API_VERSION,
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) {
    const message = messageOf(await response.text().catch(() => "")) ?? `GitHub ${response.status}`;
    throw new GitHubApiError(
      response.status,
      (failureMessage?.(response.status) ?? message).slice(0, MAX_MESSAGE_LENGTH),
      rateLimitOf(response, message),
    );
  }
  const text = await response.text();
  return (text ? JSON.parse(text) : undefined) as T;
}

function messageOf(text: string): string | null {
  try {
    const message = (JSON.parse(text) as { message?: unknown } | null)?.message;
    return typeof message === "string" && message ? message : null;
  } catch {
    return null;
  }
}

function seconds(header: string | null): number | null {
  return header !== null && /^\d+$/.test(header.trim()) ? Number(header) : null;
}

/**
 * Every answer carries `x-ratelimit-remaining`, so a permission 403 on a window's last request
 * reads 0 too. Only GitHub's message or `retry-after` marks a 403 as a limit; the reset only times
 * the wait.
 */
function rateLimitOf(response: Response, message: string) {
  const { status, headers } = response;
  const retryAfter = seconds(headers.get("retry-after"));
  const limited =
    status === 429 || (status === 403 && (retryAfter !== null || /rate limit/i.test(message)));
  if (!limited) return {};
  const reset =
    headers.get("x-ratelimit-remaining") === "0" ? seconds(headers.get("x-ratelimit-reset")) : null;
  const retryAfterMs =
    retryAfter !== null
      ? retryAfter * 1_000
      : reset !== null
        ? Math.max(0, reset * 1_000 - Date.now())
        : undefined;
  return { rateLimited: true, retryAfterMs };
}
