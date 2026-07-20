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
