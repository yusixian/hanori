import { spawn } from "node:child_process";
import { request } from "node:http";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createQuoteWorker, renderQuote } from "./server.mjs";

const image = Buffer.from("RIFFxxxxWEBPfixture");
const result = { data: image, format: "webp", width: 512, height: 100 };
const cleanups = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
async function directory() {
  const path = await mkdtemp(join(tmpdir(), "qw-"));
  cleanups.push(() => rm(path, { recursive: true, force: true }));
  return path;
}
function call(socketPath, method, path, payload) {
  return new Promise((resolve, reject) => {
    const req = request({ socketPath, method, path }, async (response) => {
      const chunks = [];
      for await (const chunk of response) chunks.push(chunk);
      resolve({
        status: response.statusCode,
        body: Buffer.concat(chunks),
        headers: response.headers,
      });
    });
    req.once("error", reject);
    req.end(payload);
  });
}

describe("offline quote worker", () => {
  it("does not advertise readiness when native glyph probe fails", async () => {
    const worker = createQuoteWorker({
      socketPath: join(await directory(), "worker.sock"),
      render: vi.fn().mockRejectedValue(new Error("missing glyph")),
    });
    await expect(worker.listen()).rejects.toThrow("missing glyph");
    expect(worker.server.listening).toBe(false);
    await worker.close();
  });
  it("cancels and awaits the native startup probe on shutdown", async () => {
    let reaped = false;
    const worker = createQuoteWorker({
      socketPath: join(await directory(), "worker.sock"),
      render: (_body, signal) =>
        new Promise((_resolve, reject) => {
          signal.addEventListener(
            "abort",
            () =>
              setTimeout(() => {
                reaped = true;
                reject(new Error("cancelled"));
              }, 10),
            { once: true },
          );
        }),
    });
    const listening = worker.listen();
    const rejected = expect(listening).rejects.toThrow("cancelled");
    await worker.close();
    await rejected;
    expect(reaped).toBe(true);
    expect(worker.server.listening).toBe(false);
  });
  it("probes CJK and emoji before exposing a socket, serves binary output and rejects overlap", async () => {
    const socket = join(await directory(), "worker.sock");
    let release;
    const gate = new Promise((resolve) => {
      release = resolve;
    });
    const render = vi
      .fn()
      .mockResolvedValueOnce(result)
      .mockImplementation(async () => {
        await gate;
        return result;
      });
    const worker = createQuoteWorker({ socketPath: socket, render });
    cleanups.push(() => worker.close());
    await worker.listen();
    expect(render.mock.calls[0][0].toString()).toContain("中文 日本語 Hello 😀❤️");
    const health = await call(socket, "GET", "/health");
    expect(JSON.parse(health.body)).toMatchObject({ ok: true, renderer: "pango-cairo" });
    const first = call(socket, "POST", "/render", "{}");
    await vi.waitFor(() => expect(render).toHaveBeenCalledTimes(2));
    expect((await call(socket, "POST", "/render", "{}")).status).toBe(409);
    release();
    const response = await first;
    expect(response.body).toEqual(image);
    expect(response.headers["content-type"]).toBe("image/webp");
  });
  it("cancels active rendering on client disconnect and releases the slot", async () => {
    const socket = join(await directory(), "worker.sock");
    let cancelled = false;
    const render = vi
      .fn()
      .mockResolvedValueOnce(result)
      .mockImplementationOnce(
        (_body, signal) =>
          new Promise((_resolve, reject) =>
            signal.addEventListener(
              "abort",
              () => {
                cancelled = true;
                reject(new Error("cancelled"));
              },
              { once: true },
            ),
          ),
      )
      .mockResolvedValue(result);
    const worker = createQuoteWorker({ socketPath: socket, render });
    cleanups.push(() => worker.close());
    await worker.listen();
    const req = request({ socketPath: socket, method: "POST", path: "/render" });
    req.on("error", () => undefined);
    req.end("{}");
    await vi.waitFor(() => expect(render).toHaveBeenCalledTimes(2));
    req.destroy();
    await vi.waitFor(() => expect(cancelled).toBe(true));
    expect((await call(socket, "POST", "/render", "{}")).status).toBe(200);
  });
  it("does not unlink another running worker's socket", async () => {
    const socket = join(await directory(), "worker.sock");
    const first = createQuoteWorker({ socketPath: socket, render: async () => result });
    cleanups.push(() => first.close());
    await first.listen();
    const second = createQuoteWorker({ socketPath: socket, render: async () => result });
    await expect(second.listen()).rejects.toThrow("socket_conflict");
    await second.close();
    expect((await call(socket, "GET", "/health")).status).toBe(200);
  });
  it.each(["timeout", "abort", "crash"])(
    "reaps %s subprocesses without credentials and removes temporary files",
    async (mode) => {
      const root = await directory();
      const controller = new AbortController();
      let child;
      const spawnProcess = (_binary, _args, options) => {
        expect(Object.keys(options.env).sort()).toEqual(["HOME", "LANG", "PATH"]);
        child = spawn(
          process.execPath,
          ["-e", mode === "crash" ? "process.exit(3)" : "setInterval(()=>{},1000)"],
          options,
        );
        if (mode === "abort") setTimeout(() => controller.abort(), 30);
        return child;
      };
      await expect(
        renderQuote(Buffer.from("{}"), controller.signal, {
          temporaryRoot: root,
          timeoutMs: 80,
          spawnProcess,
        }),
      ).rejects.toBeTruthy();
      expect(child.exitCode !== null || child.signalCode !== null).toBe(true);
      expect(await readdir(root)).toEqual([]);
    },
  );
});
