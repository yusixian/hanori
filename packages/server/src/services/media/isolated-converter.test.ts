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

  it("muxes video with only two hashes and explicit duration/byte bounds", async () => {
    const input = {
      videoSha256: SHA,
      audioSha256: "b".repeat(64),
      maxDurationSeconds: 10,
      maxBytes: 45_000_000,
    };
    expect(await converter.muxVideo(ID, input, new AbortController().signal)).toEqual({
      bytes: result.bytes,
      sha256: SHA,
      durationSeconds: 1,
    });
    expect(seen[0]).toMatchObject({ path: `/jobs/${ID}/mux-video`, body: JSON.stringify(input) });
  });

  it("rejects excess mux output instead of trusting the worker response", async () => {
    await expect(
      converter.muxVideo(
        ID,
        { videoSha256: SHA, audioSha256: SHA, maxDurationSeconds: 10, maxBytes: 10 },
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ code: "conversion_failed" });
  });

  it("rejects excessive mux limits before contacting the worker", async () => {
    await expect(
      converter.muxVideo(
        ID,
        { videoSha256: SHA, audioSha256: SHA, maxDurationSeconds: 10, maxBytes: 50_000_001 },
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ code: "conversion_failed" });
    expect(seen).toHaveLength(0);
  });

  it("serializes ASR and video FIFO requests and starts the request deadline after admission", async () => {
    const responses: ServerResponse[] = [];
    respond = (_request, response) => {
      responses.push(response);
    };
    const deadlines = vi.spyOn(AbortSignal, "timeout");
    const signal = new AbortController().signal;
    const first = converter.convert(ID, SHA, 10, signal);
    await vi.waitFor(() => expect(seen).toHaveLength(1));
    const second = converter.muxVideo(
      ID,
      { videoSha256: SHA, audioSha256: SHA, maxDurationSeconds: 10, maxBytes: 45_000_000 },
      signal,
    );
    await new Promise((resolve) => setImmediate(resolve));
    expect(seen).toHaveLength(1);
    expect(deadlines).toHaveBeenCalledTimes(1);
    responses[0]!.end(JSON.stringify(result));
    await first;
    await vi.waitFor(() => expect(seen).toHaveLength(2));
    responses[1]!.end(JSON.stringify(result));
    await second;
    expect(seen.map((value) => value.path)).toEqual([
      `/jobs/${ID}/convert`,
      `/jobs/${ID}/mux-video`,
    ]);
    expect(deadlines).toHaveBeenCalledTimes(2);
  });

  it("aborts a queued video without dispatch and leaves direct cancel available while ASR holds the slot", async () => {
    let held: ServerResponse | undefined;
    respond = (request, response) => {
      if (request.method === "DELETE") response.end(JSON.stringify({ ok: true }));
      else held = response;
    };
    const first = converter.convert(ID, SHA, 10, new AbortController().signal);
    await vi.waitFor(() => expect(seen).toHaveLength(1));
    const controller = new AbortController();
    const queued = converter.muxVideo(
      ID,
      { videoSha256: SHA, audioSha256: SHA, maxDurationSeconds: 10, maxBytes: 45_000_000 },
      controller.signal,
    );
    const cancelled = expect(queued).rejects.toMatchObject({ code: "conversion_cancelled" });
    controller.abort();
    await cancelled;
    await converter.cancel(ID);
    expect(seen.map((value) => value.method)).toEqual(["POST", "DELETE"]);
    held!.end(JSON.stringify(result));
    await first;
    respond = (_request, response) => response.end(JSON.stringify(result));
    await converter.convert(ID, SHA, 10, new AbortController().signal);
  });

  it("waits for a job held by another converter instance before retrying its unaccepted POST", async () => {
    const otherId = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
    const other = new IsolatedAudioConverter(socket, SECRET);
    let held: ServerResponse | undefined;
    let active = true;
    respond = (request, response) => {
      if (request.url === `/jobs/${ID}/convert`) held = response;
      else if (active) {
        response.statusCode = 409;
        response.end(JSON.stringify({ ok: false, error: "busy" }));
      } else response.end(JSON.stringify(result));
    };
    const first = converter.convert(ID, SHA, 10, new AbortController().signal);
    await vi.waitFor(() => expect(held).toBeDefined());
    const second = other.muxVideo(
      otherId,
      { videoSha256: SHA, audioSha256: SHA, maxDurationSeconds: 10, maxBytes: 45_000_000 },
      new AbortController().signal,
    );
    await vi.waitFor(() => expect(seen).toHaveLength(2));
    active = false;
    held!.end(JSON.stringify(result));
    await first;
    await expect(second).resolves.toMatchObject({ bytes: result.bytes });
    expect(seen.map((value) => `${value.method} ${value.path}`)).toEqual([
      `POST /jobs/${ID}/convert`,
      `POST /jobs/${otherId}/mux-video`,
      `POST /jobs/${otherId}/mux-video`,
    ]);
  });

  it("aborts while waiting on another process without another POST or cancelling its active job", async () => {
    respond = (_request, response) => {
      response.statusCode = 409;
      response.end(JSON.stringify({ ok: false, error: "busy" }));
    };
    const controller = new AbortController();
    const pending = converter.convert(ID, SHA, 10, controller.signal);
    const cancelled = expect(pending).rejects.toMatchObject({ code: "conversion_cancelled" });
    await vi.waitFor(() => expect(seen).toHaveLength(1));
    controller.abort();
    await cancelled;
    await new Promise((resolve) => setTimeout(resolve, 550));
    expect(seen.map((value) => value.method)).toEqual(["POST"]);
  });

  it("does not retry an unknown outcome or mistake a409 cancellation response for busy", async () => {
    for (const failure of ["disconnect", "internal_error", "cancelled"]) {
      seen = [];
      respond = (request, response) => {
        if (request.method === "DELETE") {
          response.end(JSON.stringify({ ok: true }));
          return;
        }
        if (failure === "disconnect") response.destroy();
        else {
          response.statusCode = failure === "cancelled" ? 409 : 500;
          response.end(
            JSON.stringify({ ok: false, error: failure === "cancelled" ? "cancelled" : "busy" }),
          );
        }
      };
      await expect(
        converter.convert(ID, SHA, 10, new AbortController().signal),
      ).rejects.toMatchObject({ code: "conversion_failed" });
      expect(seen.filter((value) => value.method === "POST")).toHaveLength(1);
    }
  });

  it("bounds cross-process busy waiting without cancelling the active job", async () => {
    const now = vi.spyOn(Date, "now");
    now.mockReturnValueOnce(0).mockReturnValue(1_830_000);
    respond = (_request, response) => {
      response.statusCode = 409;
      response.end(JSON.stringify({ ok: false, error: "busy" }));
    };
    await expect(
      converter.convert(ID, SHA, 10, new AbortController().signal),
    ).rejects.toMatchObject({ code: "conversion_failed" });
    expect(seen.map((value) => value.method)).toEqual(["POST"]);
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
    [SHA, 18001],
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

  it("accepts a two-hour ASR file and uses a separate thirty-minute conversion deadline", async () => {
    const deadlines = vi.spyOn(AbortSignal, "timeout");
    respond = (_request, response) =>
      response.end(JSON.stringify({ ...result, bytes: 44 + 7200 * 32000, durationSeconds: 7200 }));
    await expect(
      converter.convert(ID, SHA, 18000, new AbortController().signal),
    ).resolves.toMatchObject({
      bytes: 230400044,
      durationSeconds: 7200,
    });
    expect(deadlines).toHaveBeenCalledWith(1810000);
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
    respond = (request, response) => {
      if (request.method === "DELETE") {
        response.statusCode = 404;
        response.end(JSON.stringify({ ok: false }));
        return;
      }
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
    expect(timeout).toHaveBeenCalledWith(1_810_000);
  });
});
