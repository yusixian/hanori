import { createHmac } from "node:crypto";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { CodingWorkerClient } from "./coding-worker-client.js";

const WORKER_SECRET = "worker-secret";

function signedHealth(url: string, bootId: string, secret = WORKER_SECRET): Response {
  const parsed = new URL(url, "http://coding-worker");
  const challenge = parsed.searchParams.get("challenge");
  if (!challenge) throw new Error("health challenge missing in test request");
  const proof = createHmac("sha256", secret)
    .update("cos-tool-bot/coding-worker-health/v1\0")
    .update(challenge)
    .update("\0")
    .update(bootId)
    .digest("base64url");
  return Response.json({ ok: true, bootId, challenge, proof });
}

describe("CodingWorkerClient", () => {
  it("uses the Unix socket transport and observes the next boot id", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "coding-worker-client-test-"));
    const socketPath = path.join(directory, "worker.sock");
    let healthCalls = 0;
    const server = createServer((request, response) => {
      response.setHeader("Content-Type", "application/json");
      if (request.url?.startsWith("/health?challenge=")) {
        healthCalls += 1;
        const signed = signedHealth(request.url, `boot-${healthCalls}`);
        void signed.json().then((body) => response.end(JSON.stringify(body)));
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
      .mockImplementationOnce((url: string) => signedHealth(url, "boot-1"))
      .mockResolvedValueOnce(
        Response.json({ ok: true, result: { summary: "done", durationMs: 1 } }),
      )
      .mockImplementationOnce((url: string) => signedHealth(url, "boot-2"));
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
      .mockImplementationOnce((url: string) => signedHealth(url, "boot-1"))
      .mockResolvedValueOnce(Response.json({ ok: false, error: "job failed" }))
      .mockImplementationOnce((url: string) => signedHealth(url, "boot-2"));
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
      .mockImplementationOnce((url: string) => signedHealth(url, "boot-1"))
      .mockResolvedValueOnce(Response.json({ ok: true, result: { summary: 42 } }))
      .mockImplementationOnce((url: string) => signedHealth(url, "boot-2"));
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
      .mockImplementationOnce((url: string) => signedHealth(url, "boot-1"))
      .mockResolvedValueOnce(
        Response.json({ ok: true, result: { summary: "done", durationMs: 1 } }),
      )
      .mockImplementation((url: string) => signedHealth(url, "boot-1"));
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
      .mockImplementationOnce((url: string) => signedHealth(url, "boot-1"))
      .mockImplementationOnce(
        (_url, init: RequestInit) =>
          new Promise<Response>((_resolve, reject) => {
            init.signal?.addEventListener("abort", () => reject(init.signal?.reason), {
              once: true,
            });
          }),
      )
      .mockImplementationOnce((url: string) => signedHealth(url, "boot-2"));
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

  it.each([
    ["missing", (_url: string) => Response.json({ ok: true, bootId: "forged-boot" })],
    [
      "forged",
      (url: string) => {
        const challenge = new URL(url).searchParams.get("challenge");
        return Response.json({ ok: true, bootId: "forged-boot", challenge, proof: "forged" });
      },
    ],
  ])("rejects a %s restart proof from a fake control server", async (_kind, responseFor) => {
    const fetchMock = vi.fn().mockImplementation(responseFor);
    const client = new CodingWorkerClient({
      url: "http://coding-worker:3010",
      secret: WORKER_SECRET,
      fetch: fetchMock,
      restartTimeoutMs: 10,
      pollIntervalMs: 10,
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
    expect(fetchMock).toHaveBeenCalled();
    for (const [url] of fetchMock.mock.calls) {
      expect(new URL(url).searchParams.get("challenge")).toMatch(/^[A-Za-z0-9_-]{43}$/);
    }
  });

  it("rejects a forged proof from a fake Unix-socket server that sees the challenge", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "coding-worker-forgery-test-"));
    const socketPath = path.join(directory, "worker.sock");
    let observedChallenge: string | undefined;
    const server = createServer((request, response) => {
      observedChallenge =
        new URL(request.url ?? "/", "http://worker").searchParams.get("challenge") ?? undefined;
      response.setHeader("Content-Type", "application/json");
      response.end(
        JSON.stringify({
          ok: true,
          bootId: "forged-boot",
          challenge: observedChallenge,
          proof: Buffer.alloc(32, 7).toString("base64url"),
        }),
      );
    });
    await new Promise<void>((resolve) => server.listen(socketPath, resolve));
    try {
      const client = new CodingWorkerClient({
        url: "",
        socketPath,
        secret: WORKER_SECRET,
        restartTimeoutMs: 10,
        pollIntervalMs: 10,
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
      expect(observedChallenge).toMatch(/^[A-Za-z0-9_-]{43}$/);
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("rejects a valid proof replayed for an earlier broker challenge", async () => {
    let replay: unknown;
    const fetchMock = vi
      .fn()
      .mockImplementationOnce(async (url: string) => {
        const response = signedHealth(url, "boot-1");
        replay = await response.clone().json();
        return response;
      })
      .mockResolvedValueOnce(
        Response.json({ ok: true, result: { summary: "done", durationMs: 1 } }),
      )
      .mockImplementation(() => Response.json(replay));
    const client = new CodingWorkerClient({
      url: "http://coding-worker:3010",
      secret: WORKER_SECRET,
      fetch: fetchMock,
      restartTimeoutMs: 10,
      pollIntervalMs: 10,
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
});
