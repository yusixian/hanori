import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { CodingWorkerClient } from "./coding-worker-client.js";

describe("CodingWorkerClient", () => {
  it("uses the Unix socket transport and observes the next boot id", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "coding-worker-client-test-"));
    const socketPath = path.join(directory, "worker.sock");
    let healthCalls = 0;
    const server = createServer((request, response) => {
      response.setHeader("Content-Type", "application/json");
      if (request.url === "/health") {
        healthCalls += 1;
        response.end(JSON.stringify({ ok: true, bootId: `boot-${healthCalls}` }));
        return;
      }
      expect(request.headers.authorization).toBe("Bearer worker-secret");
      response.end(JSON.stringify({ ok: true, result: { summary: "done", durationMs: 1 } }));
    });
    await new Promise<void>((resolve) => server.listen(socketPath, resolve));
    try {
      const client = new CodingWorkerClient({ url: "", socketPath, secret: "worker-secret" });
      await expect(
        client.run({
          workspacePath: "workspace",
          task: "change code",
          timeoutMs: 60_000,
          model: {
            apiKey: "model-secret",
            baseURL: "https://example.com/v1",
            id: "model",
            providerFormat: "openai",
            capabilities: ["tool_calling", "code"],
          },
        }),
      ).resolves.toEqual({ summary: "done", durationMs: 1 });
      expect(healthCalls).toBe(2);
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("authenticates the internal call without adding GitHub credentials", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(Response.json({ ok: true, bootId: "boot-1" }))
      .mockResolvedValueOnce(
        Response.json({ ok: true, result: { summary: "done", durationMs: 1 } }),
      )
      .mockResolvedValueOnce(Response.json({ ok: true, bootId: "boot-2" }));
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
        capabilities: ["tool_calling", "code"],
      },
    });

    const [, init] = fetchMock.mock.calls[1]!;
    expect(init.headers.Authorization).toBe("Bearer worker-secret");
    expect(init.body).toContain("model-secret");
    expect(init.body).not.toContain("github");
  });

  it("rejects an explicit worker failure even when the response is HTTP 200", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(Response.json({ ok: true, bootId: "boot-1" }))
      .mockResolvedValueOnce(Response.json({ ok: false, error: "job failed" }))
      .mockResolvedValueOnce(Response.json({ ok: true, bootId: "boot-2" }));
    const client = new CodingWorkerClient({
      url: "http://coding-worker:3010",
      secret: "worker-secret",
      fetch: fetchMock,
    });

    await expect(
      client.run({
        workspacePath: "bot/owner/repo",
        task: "change code",
        timeoutMs: 60_000,
        model: {
          apiKey: "model-secret",
          baseURL: "https://example.com/v1",
          id: "model",
          providerFormat: "openai",
          capabilities: ["tool_calling", "code"],
        },
      }),
    ).rejects.toThrow("Pi coding worker failed (200): job failed");
  });

  it("rejects a malformed success result", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(Response.json({ ok: true, bootId: "boot-1" }))
      .mockResolvedValueOnce(Response.json({ ok: true, result: { summary: 42 } }))
      .mockResolvedValueOnce(Response.json({ ok: true, bootId: "boot-2" }));
    const client = new CodingWorkerClient({
      url: "http://coding-worker:3010",
      secret: "worker-secret",
      fetch: fetchMock,
    });

    await expect(
      client.run({
        workspacePath: "bot/owner/repo",
        task: "change code",
        timeoutMs: 60_000,
        model: {
          apiKey: "model-secret",
          baseURL: "https://example.com/v1",
          id: "model",
          providerFormat: "openai",
          capabilities: ["tool_calling", "code"],
        },
      }),
    ).rejects.toThrow("Pi coding worker failed (200)");
  });

  it("does not return a successful result until a different worker boot is healthy", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(Response.json({ ok: true, bootId: "boot-1" }))
      .mockResolvedValueOnce(
        Response.json({ ok: true, result: { summary: "done", durationMs: 1 } }),
      )
      .mockResolvedValue(Response.json({ ok: true, bootId: "boot-1" }));
    const client = new CodingWorkerClient({
      url: "http://coding-worker:3010",
      secret: "worker-secret",
      fetch: fetchMock,
      restartTimeoutMs: 1,
      pollIntervalMs: 1,
      sleep: async () => {},
    });

    await expect(
      client.run({
        workspacePath: "workspace",
        task: "change code",
        timeoutMs: 60_000,
        model: {
          apiKey: "model-secret",
          baseURL: "https://example.com/v1",
          id: "model",
          providerFormat: "openai",
          capabilities: ["tool_calling", "code"],
        },
      }),
    ).rejects.toThrow("did not restart with a new boot id");
  });

  it("propagates cancellation but still waits for the one-shot worker restart", async () => {
    const controller = new AbortController();
    const reason = new Error("stopped");
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(Response.json({ ok: true, bootId: "boot-1" }))
      .mockImplementationOnce(
        (_url, init: RequestInit) =>
          new Promise<Response>((_resolve, reject) => {
            init.signal?.addEventListener("abort", () => reject(init.signal?.reason), {
              once: true,
            });
          }),
      )
      .mockResolvedValueOnce(Response.json({ ok: true, bootId: "boot-2" }));
    const client = new CodingWorkerClient({
      url: "http://coding-worker:3010",
      secret: "worker-secret",
      fetch: fetchMock,
    });

    const result = client.run(
      {
        workspacePath: "workspace",
        task: "change code",
        timeoutMs: 60_000,
        model: {
          apiKey: "model-secret",
          baseURL: "https://example.com/v1",
          id: "model",
          providerFormat: "openai",
          capabilities: ["tool_calling", "code"],
        },
      },
      controller.signal,
    );
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    controller.abort(reason);

    await expect(result).rejects.toBe(reason);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });
});
