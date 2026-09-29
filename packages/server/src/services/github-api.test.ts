import { afterEach, describe, expect, it, vi } from "vitest";
import { GitHubApiError, type GitHubRequestInit, githubRequest } from "./github-api.js";

function answering(status: number, body?: unknown, headers: Record<string, string> = {}) {
  const text = body === undefined ? null : typeof body === "string" ? body : JSON.stringify(body);
  return vi.fn<typeof fetch>(async () => new Response(text, { status, headers }));
}

async function failure(
  status: number,
  body: unknown,
  headers?: Record<string, string>,
  init?: GitHubRequestInit,
) {
  const error = await githubRequest(answering(status, body, headers), "/repos/o/r", "t", init).then(
    () => null,
    (reason: unknown) => reason,
  );
  expect(error).toBeInstanceOf(GitHubApiError);
  return error as GitHubApiError;
}

afterEach(() => {
  vi.useRealTimers();
});

describe("githubRequest", () => {
  it("sends one authenticated JSON request and resolves the parsed answer", async () => {
    const fetchImpl = answering(201, { number: 7 });
    await expect(
      githubRequest(fetchImpl, "/repos/o/r/issues", "installation-token", {
        method: "POST",
        body: JSON.stringify({ title: "x" }),
      }),
    ).resolves.toEqual({ number: 7 });
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toBe("https://api.github.com/repos/o/r/issues");
    expect(init).toMatchObject({ method: "POST", body: '{"title":"x"}' });
    expect(init?.headers).toEqual({
      Accept: "application/vnd.github+json",
      Authorization: "Bearer installation-token",
      "User-Agent": "cos-tool-bot",
      "X-GitHub-Api-Version": "2022-11-28",
      "Content-Type": "application/json",
    });
    expect(init?.signal).toBeInstanceOf(AbortSignal);
  });

  it("resolves undefined for an empty answer", async () => {
    await expect(githubRequest(answering(204), "/repos/o/r", "t")).resolves.toBeUndefined();
  });

  it("classifies 404 as not_found with GitHub's own message", async () => {
    const error = await failure(404, { message: "Branch not protected" });
    expect(error).toMatchObject({ status: 404, kind: "not_found", retryAfterMs: null });
    expect(error.message).toBe("Branch not protected");
  });

  it("classifies a permission 403 as forbidden, even on the window's last request", async () => {
    const error = await failure(
      403,
      { message: "Resource not accessible by integration" },
      { "x-ratelimit-remaining": "0", "x-ratelimit-reset": "1790000000" },
    );
    expect(error).toMatchObject({ status: 403, kind: "forbidden", retryAfterMs: null });
  });

  it("classifies an exhausted primary rate limit 403 and waits until the reset", async () => {
    vi.setSystemTime(new Date("2026-09-29T00:00:00Z"));
    const reset = Date.parse("2026-09-29T00:01:30Z") / 1000;
    const error = await failure(
      403,
      { message: "API rate limit exceeded for installation ID 1." },
      { "x-ratelimit-remaining": "0", "x-ratelimit-reset": String(reset) },
    );
    expect(error).toMatchObject({ status: 403, kind: "rate_limited", retryAfterMs: 90_000 });
  });

  it("classifies a secondary rate limit 403 by its message and honours retry-after", async () => {
    const error = await failure(
      403,
      { message: "You have exceeded a secondary rate limit. Please wait a few minutes." },
      { "retry-after": "60" },
    );
    expect(error).toMatchObject({ kind: "rate_limited", retryAfterMs: 60_000 });
  });

  it("classifies 429 as rate_limited and reads retry-after", async () => {
    const error = await failure(429, { message: "Too Many Requests" }, { "retry-after": "30" });
    expect(error).toMatchObject({ status: 429, kind: "rate_limited", retryAfterMs: 30_000 });
    const bare = await failure(429, "");
    expect(bare).toMatchObject({ kind: "rate_limited", retryAfterMs: null });
  });

  it("falls back to the status for a non-JSON error page", async () => {
    const error = await failure(502, "<html>Bad gateway</html>");
    expect(error).toMatchObject({ status: 502, kind: "other", message: "GitHub 502" });
  });

  it("uses the caller's failure message but still classifies by GitHub's answer", async () => {
    const error = await failure(
      403,
      { message: "You have exceeded a secondary rate limit." },
      {},
      { failureMessage: (status) => `GitHub API 请求失败 (${status})` },
    );
    expect(error).toMatchObject({ message: "GitHub API 请求失败 (403)", kind: "rate_limited" });
  });
});
