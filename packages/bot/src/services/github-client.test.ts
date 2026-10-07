import { describe, expect, it, vi } from "vitest";
import { GitHubApiError, GitHubClient } from "./github-client.js";

describe("GitHubClient errors", () => {
  it("carries GitHub's status and a message safe to show", async () => {
    const fetchMock = vi.fn(async () => new Response("{}", { status: 429 }));
    const client = new GitHubClient({ token: "token", fetch: fetchMock as typeof fetch });

    const error = await client.getRepository("owner/repo").catch((e: unknown) => e);
    expect(error).toBeInstanceOf(GitHubApiError);
    expect(error).toMatchObject({
      status: 429,
      message: "GitHub rate-limited the request; try again later",
    });
    await expect(client.getRepository("../repo")).rejects.toMatchObject({ status: 400 });
  });
});

describe("GitHubClient cancellation", () => {
  it("combines a caller signal with the request timeout", async () => {
    const controller = new AbortController();
    const reason = new Error("runtime destroyed");
    let requestSignal: AbortSignal | undefined;
    const fetchMock = vi.fn(
      async (_input: string | URL | Request, init?: RequestInit): Promise<Response> => {
        requestSignal = init?.signal ?? undefined;
        return await new Promise<Response>((_resolve, reject) => {
          requestSignal?.addEventListener("abort", () => reject(requestSignal?.reason), {
            once: true,
          });
        });
      },
    );
    const client = new GitHubClient({ token: "token", fetch: fetchMock as typeof fetch });

    const request = client.createIssue(
      "owner/repo",
      { title: "Cancelled mutation" },
      controller.signal,
    );
    await vi.waitFor(() => expect(requestSignal).toBeDefined());
    expect(requestSignal).not.toBe(controller.signal);
    controller.abort(reason);

    await expect(request).rejects.toBe(reason);
    expect(requestSignal?.aborted).toBe(true);
  });
});

describe("GitHubClient dynamic credentials", () => {
  it("resolves a fresh token immediately before every API request", async () => {
    const tokenProvider = vi
      .fn<() => Promise<string | undefined>>()
      .mockResolvedValueOnce("installation-token-1")
      .mockResolvedValueOnce("installation-token-2");
    const authorizations: string[] = [];
    const fetchMock = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      authorizations.push(new Headers(init?.headers).get("Authorization") ?? "");
      return new Response(
        JSON.stringify({
          full_name: "owner/repo",
          private: true,
          default_branch: "main",
          html_url: "https://github.com/owner/repo",
          description: null,
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    });
    const client = new GitHubClient({ tokenProvider, fetch: fetchMock as typeof fetch });

    await client.getRepository("owner/repo");
    await client.getRepository("owner/repo");

    expect(authorizations).toEqual(["Bearer installation-token-1", "Bearer installation-token-2"]);
    expect(tokenProvider).toHaveBeenCalledTimes(2);
  });
});

describe("Issue proposal reconciliation", () => {
  it("reads later pages with current authentication and never selects a matching PR", async () => {
    const issue = { number: 42, title: "Title", body: "Exact immutable body" };
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify(Array.from({ length: 100 }, () => ({ ...issue, pull_request: {} }))),
        ),
      )
      .mockResolvedValueOnce(new Response(JSON.stringify([issue])));
    const client = new GitHubClient({ token: "current", fetch: fetchMock });
    expect(await client.findIssueByProposal("owner/repo", issue.title, issue.body)).toEqual(issue);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[1]?.[0]).toContain("page=2");
    expect(new Headers(fetchMock.mock.calls[1]?.[1]?.headers).get("Authorization")).toBe(
      "Bearer current",
    );
    expect(fetchMock.mock.calls.every(([, init]) => !init?.method)).toBe(true);
  });
  it("bounds recovery scanning and refuses ambiguous matches", async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify(Array.from({ length: 100 }, () => ({ title: "unrelated" })))),
    );
    const client = new GitHubClient({ token: "current", fetch: fetchMock });
    expect(await client.findIssueByProposal("owner/repo", "Title", "Body")).toBeUndefined();
    expect(fetchMock).toHaveBeenCalledTimes(10);
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify([
          { title: "Title", body: "Body" },
          { title: "Title", body: "Body" },
        ]),
      ),
    );
    await expect(client.findIssueByProposal("owner/repo", "Title", "Body")).rejects.toThrow(
      "Multiple Issues",
    );
  });
});
