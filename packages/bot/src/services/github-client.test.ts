import { describe, expect, it, vi } from "vitest";
import { GitHubClient } from "./github-client.js";

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
