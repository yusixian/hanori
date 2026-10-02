import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { IsolatedAudioConverter } from "./isolated-converter.js";

const SECRET = "synthetic-worker-secret-with-32-characters";
const ID = "11111111-2222-3333-4444-555555555555";
const SHA = "a".repeat(64);
const result = { ok: true, bytes: 32_044, sha256: SHA, durationSeconds: 1 };

describe("isolated converter Unix protocol", () => {
  let directory: string;
  let socket: string;
  let server: ReturnType<typeof createServer>;
  let converter: IsolatedAudioConverter;
  let respond: (request: IncomingMessage, response: ServerResponse) => void;
  let seen: Array<{ method: string; path: string; authorization?: string; body: string }>;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "converter-test-"));
    socket = join(directory, "worker.sock");
    seen = [];
    respond = (_request, response) => response.end(JSON.stringify(result));
    server = createServer(async (request, response) => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      seen.push({
        method: request.method!,
        path: request.url!,
        authorization: request.headers.authorization,
        body: Buffer.concat(chunks).toString("utf8"),
      });
      respond(request, response);
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(socket, resolve);
    });
    converter = new IsolatedAudioConverter(socket, SECRET);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
  });

  it("sends only the checksum and duration, with authentication in a header", async () => {
    expect(await converter.convert(ID, SHA, 10, new AbortController().signal)).toEqual({
      bytes: result.bytes,
      sha256: SHA,
      durationSeconds: 1,
    });
    expect(seen).toEqual([
      {
        method: "POST",
        path: `/jobs/${ID}/convert`,
        authorization: `Bearer ${SECRET}`,
        body: JSON.stringify({ sha256: SHA, maxDurationSeconds: 10 }),
      },
    ]);
    expect(seen[0]!.path + seen[0]!.body).not.toContain(SECRET);
  });

  it("uses authenticated health and idempotent cancellation of unknown jobs", async () => {
    respond = (request, response) => {
      response.statusCode = request.method === "DELETE" ? 404 : 200;
      response.end(JSON.stringify({ ok: request.method !== "DELETE", error: "not_found" }));
    };
    await converter.health();
    await converter.cancel(ID);
    expect(
      seen.map(({ method, path, authorization }) => ({ method, path, authorization })),
    ).toEqual([
      { method: "GET", path: "/health", authorization: `Bearer ${SECRET}` },
      { method: "DELETE", path: `/jobs/${ID}`, authorization: `Bearer ${SECRET}` },
    ]);
  });

  it.each(["", "short", `${SECRET}\r\nInjected: value`])("rejects invalid secret %j", (secret) => {
    expect(() => new IsolatedAudioConverter(socket, secret)).toThrow("converter_unavailable");
  });

  it.each(["https://worker.example/convert", "worker.sock"])(
    "rejects a nonabsolute Unix socket %j",
    (path) => {
      expect(() => new IsolatedAudioConverter(path, SECRET)).toThrow("converter_unavailable");
    },
  );

  it.each(["../input.m4a", "/private/provider-secret", "https://cdn.example/audio.m4a"])(
    "rejects a source path or URL in place of the job ID: %s",
    async (id) => {
      await expect(
        converter.convert(id, SHA, 10, new AbortController().signal),
      ).rejects.toMatchObject({
        code: "conversion_failed",
      });
      expect(seen).toHaveLength(0);
    },
  );

  it.each([
    ["A".repeat(64), 10],
    [SHA, 0],
    [SHA, Number.MAX_SAFE_INTEGER + 1],
    [SHA, 1.5],
  ] as const)(
    "rejects invalid checksum/duration before contacting the worker",
    async (sha, duration) => {
      await expect(
        converter.convert(ID, sha, duration, new AbortController().signal),
      ).rejects.toMatchObject({
        code: "conversion_failed",
      });
      expect(seen).toHaveLength(0);
    },
  );

  it("accepts601s under a configured larger limit and rejects excess metadata", async () => {
    respond = (_request, response) =>
      response.end(JSON.stringify({ ...result, bytes: 19_232_044, durationSeconds: 601 }));
    await expect(converter.convert(ID, SHA, 900, new AbortController().signal)).resolves.toEqual({
      bytes: 19_232_044,
      sha256: SHA,
      durationSeconds: 601,
    });
    await expect(
      converter.convert(ID, SHA, 600, new AbortController().signal),
    ).rejects.toMatchObject({
      code: "conversion_failed",
    });
  });

  it("bounds the worker response before parsing", async () => {
    respond = (_request, response) => response.end(" ".repeat(4097));
    await expect(converter.health()).rejects.toMatchObject({ code: "conversion_failed" });
  });

  it.each([
    { ...result, bytes: 20 * 1024 * 1024 + 1 },
    { ...result, bytes: 1.5 },
    { ...result, sha256: "invalid" },
    { ...result, durationSeconds: 11 },
    { ...result, durationSeconds: 0 },
  ])("rejects forged conversion metadata %j", async (body) => {
    respond = (_request, response) => response.end(JSON.stringify(body));
    await expect(
      converter.convert(ID, SHA, 10, new AbortController().signal),
    ).rejects.toMatchObject({
      code: "conversion_failed",
    });
  });

  it("returns a safe enum instead of worker stderr, secrets or paths", async () => {
    respond = (_request, response) => {
      response.statusCode = 400;
      response.end(JSON.stringify({ ok: false, error: `${SECRET} /private/input ffmpeg-stderr` }));
    };
    await expect(
      converter.convert(ID, SHA, 10, new AbortController().signal),
    ).rejects.toMatchObject({
      message: "conversion_failed",
      code: "conversion_failed",
    });
  });

  it("closes an in-flight request on caller cancellation", async () => {
    let closed = false;
    respond = (_request, response) => {
      response.once("close", () => {
        closed = true;
      });
    };
    const controller = new AbortController();
    const pending = converter.convert(ID, SHA, 10, controller.signal);
    const rejected = expect(pending).rejects.toMatchObject({ code: "conversion_cancelled" });
    await vi.waitFor(() => expect(seen).toHaveLength(1));
    controller.abort();
    await rejected;
    await vi.waitFor(() => expect(closed).toBe(true));
  });

  it("bounds a stalled request with its conversion deadline", async () => {
    respond = () => undefined;
    const nativeTimeout = AbortSignal.timeout.bind(AbortSignal);
    const timeout = vi.spyOn(AbortSignal, "timeout").mockImplementation(() => nativeTimeout(20));
    await expect(
      converter.convert(ID, SHA, 10, new AbortController().signal),
    ).rejects.toMatchObject({
      code: "conversion_failed",
    });
    expect(timeout).toHaveBeenCalledWith(130_000);
  });
});
