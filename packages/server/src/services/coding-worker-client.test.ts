import { createHmac } from "node:crypto";
import { createServer } from "node:http";
import { mkdtemp, rm, unlink } from "node:fs/promises";
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

function acceptedResponse(body: unknown, bootId = "boot-1"): Response {
  return Response.json(body, {
    headers: { "X-Coding-Worker-Accepted-Boot-Id": bootId },
  });
}

describe("CodingWorkerClient", () => {
  it("binds the job envelope to the signed preflight boot and rejects a restarted worker", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "coding-worker-boot-race-test-"));
    const socketPath = path.join(directory, "worker.sock");
    let envelope: unknown;
    const server = createServer((request, response) => {
      response.setHeader("Content-Type", "application/json");
      if (request.url?.startsWith("/health?challenge=")) {
        const signed = signedHealth(request.url, "boot-one");
        void signed.json().then((body) => response.end(JSON.stringify(body)));
        return;
      }
      const chunks: Buffer[] = [];
      request.on("data", (chunk: Buffer) => chunks.push(chunk));
      request.on("end", () => {
        envelope = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        response.writeHead(409).end(JSON.stringify({ error: "worker boot changed" }));
      });
    });
    await new Promise<void>((resolve) => server.listen(socketPath, resolve));
    try {
      const client = new CodingWorkerClient({ url: "", socketPath, secret: WORKER_SECRET });

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
      ).rejects.toThrow("Pi coding worker failed (409): worker boot changed");
      expect(envelope).toEqual({
        expectedBootId: "boot-one",
        job: expect.objectContaining({ workspacePath: "workspace", task: "change code" }),
      });
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("rejects an already-aborted Unix-socket run before opening the socket", async () => {
    const reason = new Error("stopped before request");
    const controller = new AbortController();
    controller.abort(reason);
    const client = new CodingWorkerClient({
      url: "",
      socketPath: "/path/that/must/not/be-opened.sock",
      secret: WORKER_SECRET,
    });

    await expect(
      client.run(
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
      ),
    ).rejects.toBe(reason);
  });

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
      response.writeProcessing();
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

  it("returns cancellation promptly and gates the next job on a fresh signed boot", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "coding-worker-stale-gate-test-"));
    const socketPath = path.join(directory, "worker.sock");
    const controller = new AbortController();
    const reason = new Error("bot stopped");
    let initialJobAborted = false;
    let allowFreshBoot = false;
    let staleHealthCalls = 0;
    let jobCalls = 0;
    const acceptedBoots: string[] = [];
    const server = createServer((request, response) => {
      response.setHeader("Content-Type", "application/json");
      if (request.url?.startsWith("/health?challenge=")) {
        let bootId = "boot-one";
        if (initialJobAborted && allowFreshBoot) {
          staleHealthCalls += 1;
          if (staleHealthCalls >= 2) bootId = jobCalls >= 2 ? "boot-three" : "boot-two";
        }
        const signed = signedHealth(request.url, bootId);
        void signed.json().then((body) => response.end(JSON.stringify(body)));
        return;
      }
      const chunks: Buffer[] = [];
      request.on("data", (chunk: Buffer) => chunks.push(chunk));
      request.on("end", () => {
        const envelope = JSON.parse(Buffer.concat(chunks).toString("utf8")) as {
          expectedBootId: string;
        };
        jobCalls += 1;
        acceptedBoots.push(envelope.expectedBootId);
        response.writeProcessing();
        if (jobCalls === 1) {
          request.once("aborted", () => {
            initialJobAborted = true;
          });
          response.once("close", () => {
            initialJobAborted = true;
          });
          return;
        }
        response.end(JSON.stringify({ ok: true, result: { summary: "done", durationMs: 1 } }));
      });
    });
    await new Promise<void>((resolve) => server.listen(socketPath, resolve));
    try {
      const client = new CodingWorkerClient({
        url: "",
        socketPath,
        secret: WORKER_SECRET,
        restartTimeoutMs: 1_000,
        pollIntervalMs: 1,
      });
      const codingJob: Parameters<CodingWorkerClient["run"]>[0] = {
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
      };

      const firstRun = client.run(codingJob, controller.signal);
      await vi.waitFor(() => expect(jobCalls).toBe(1));
      controller.abort(reason);
      const promptOutcome = await Promise.race([
        firstRun.catch((error: unknown) => error),
        new Promise((resolve) => setTimeout(() => resolve("timed out"), 100)),
      ]);
      expect(promptOutcome).toBe(reason);
      await vi.waitFor(() => expect(initialJobAborted).toBe(true));
      allowFreshBoot = true;
      staleHealthCalls = 0;

      await expect(client.run(codingJob)).resolves.toEqual({ summary: "done", durationMs: 1 });
      expect(staleHealthCalls).toBeGreaterThanOrEqual(2);
      expect(acceptedBoots).toEqual(["boot-one", "boot-two"]);
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
      await rm(directory, { recursive: true, force: true });
    }
  });

  it.each([
    [401, "unauthorized"],
    [400, "invalid job"],
    [409, "Coding worker is busy"],
  ])(
    "does not consume or restart-wait after an unaccepted HTTP %s response",
    async (status, error) => {
      const server = createServer((request, response) => {
        response.setHeader("Content-Type", "application/json");
        if (request.url?.startsWith("/health?challenge=")) {
          const signed = signedHealth(request.url, "boot-one");
          void signed.json().then((body) => response.end(JSON.stringify(body)));
          return;
        }
        response.writeHead(status).end(JSON.stringify({ error }));
      });
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("HTTP test server did not bind");
      try {
        const client = new CodingWorkerClient({
          url: `http://127.0.0.1:${address.port}`,
          secret: WORKER_SECRET,
          sleep: async () => {
            throw new Error("unexpected restart wait");
          },
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
        ).rejects.toThrow(`Pi coding worker failed (${status}): ${error}`);
      } finally {
        await new Promise<void>((resolve, reject) =>
          server.close((closeError) => (closeError ? reject(closeError) : resolve())),
        );
      }
    },
  );

  it("does not restart-wait when the HTTP worker disappears after preflight", async () => {
    const sleep = vi.fn(async () => {
      throw new Error("unexpected restart wait");
    });
    const server = createServer((request, response) => {
      if (!request.url?.startsWith("/health?challenge=")) {
        response.writeHead(500).end();
        return;
      }
      const signed = signedHealth(request.url, "boot-one");
      void signed.json().then((body) => {
        response.setHeader("Connection", "close");
        server.close();
        response.end(JSON.stringify(body));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("HTTP test server did not bind");
    const client = new CodingWorkerClient({
      url: `http://127.0.0.1:${address.port}`,
      secret: WORKER_SECRET,
      sleep,
    });

    const error = await client
      .run({
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
      })
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).not.toContain("restart");
    expect(sleep).not.toHaveBeenCalled();
  });

  it("authenticates the internal call without adding GitHub credentials", async () => {
    const fetchMock = vi
      .fn()
      .mockImplementationOnce((url: string) => signedHealth(url, "boot-1"))
      .mockResolvedValueOnce(
        acceptedResponse({ ok: true, result: { summary: "done", durationMs: 1 } }),
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
      .mockResolvedValueOnce(acceptedResponse({ ok: false, error: "job failed" }))
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
      .mockResolvedValueOnce(acceptedResponse({ ok: true, result: { summary: 42 } }))
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
        acceptedResponse({ ok: true, result: { summary: "done", durationMs: 1 } }),
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

  it("does not treat an aborted injected fetch as accepted without an acceptance marker", async () => {
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
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("does not mask cancellation when the accepted worker fails to restart", async () => {
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
      .mockImplementation((url: string) => signedHealth(url, "boot-1"));
    const client = new CodingWorkerClient({
      url: "http://coding-worker:3010",
      secret: WORKER_SECRET,
      fetch: fetchMock,
      restartTimeoutMs: 1,
      pollIntervalMs: 1,
      sleep: async () => {},
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
  });

  it("does not wait for a restart when a Unix-socket job was never accepted", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "coding-worker-not-accepted-test-"));
    const socketPath = path.join(directory, "worker.sock");
    const sleep = vi.fn(async () => {
      throw new Error("unexpected restart wait");
    });
    const server = createServer((request, response) => {
      if (!request.url?.startsWith("/health?challenge=")) {
        response.writeHead(500).end();
        return;
      }
      const signed = signedHealth(request.url, "boot-1");
      void signed.json().then(async (body) => {
        await unlink(socketPath);
        response.setHeader("Content-Type", "application/json");
        response.setHeader("Connection", "close");
        response.end(JSON.stringify(body));
      });
    });
    await new Promise<void>((resolve) => server.listen(socketPath, resolve));
    try {
      const client = new CodingWorkerClient({
        url: "",
        socketPath,
        secret: WORKER_SECRET,
        restartTimeoutMs: 1_000,
        pollIntervalMs: 1,
        sleep,
      });

      const error = await client
        .run({
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
        })
        .catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).not.toContain("unexpected restart wait");
      expect((error as Error).message).not.toContain("did not restart with a new boot id");
      expect(sleep).not.toHaveBeenCalled();
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
      await rm(directory, { recursive: true, force: true });
    }
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
        acceptedResponse({ ok: true, result: { summary: "done", durationMs: 1 } }),
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
