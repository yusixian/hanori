import { describe, expect, it, vi } from "vitest";
import { CodingWorkerClient } from "./coding-worker-client.js";

describe("CodingWorkerClient", () => {
  it("authenticates the internal call without adding GitHub credentials", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(Response.json({ ok: true, result: { summary: "done", durationMs: 1 } }));
    const client = new CodingWorkerClient({
      url: "http://coding-worker:3010/",
      secret: "worker-secret",
      fetch: fetchMock,
    });

    await client.run({
      workspacePath: "bot/owner/repo",
      task: "change code",
      timeoutMs: 60_000,
      model: {
        apiKey: "model-secret",
        baseURL: "https://example.com/v1",
        id: "model",
        providerFormat: "openai",
      },
    });

    const [, init] = fetchMock.mock.calls[0]!;
    expect(init.headers.Authorization).toBe("Bearer worker-secret");
    expect(init.body).toContain("model-secret");
    expect(init.body).not.toContain("github");
  });
});
