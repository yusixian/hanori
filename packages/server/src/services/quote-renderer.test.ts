import { createServer, type ServerResponse, type IncomingMessage } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { QuoteRendererClient } from "./quote-renderer.js";

const payload = {
  background: "#251D3A",
  messages: [{ author: { key: "fiction", name: "小林" }, text: "hello" }],
};
const webp = Buffer.from("RIFFxxxxWEBPfixture");
describe("quote renderer Unix client", () => {
  let directory: string;
  let server: ReturnType<typeof createServer>;
  let client: QuoteRendererClient;
  let calls: string[];
  let respond: (request: IncomingMessage, response: ServerResponse) => void;
  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "qc-"));
    const socket = join(directory, "worker.sock");
    calls = [];
    respond = (request, response) => {
      if (request.url === "/health")
        response.end(JSON.stringify({ ok: true, renderer: "pango-cairo", version: 1 }));
      else {
        response.writeHead(200, {
          "content-type": "image/webp",
          "x-quote-width": "512",
          "x-quote-height": "240",
        });
        response.end(webp);
      }
    };
    server = createServer(async (request, response) => {
      let body = "";
      for await (const chunk of request) body += chunk;
      calls.push(`${request.method} ${request.url} ${body}`);
      respond(request, response);
    });
    await new Promise<void>((resolveListen, reject) => {
      server.once("error", reject);
      server.listen(socket, resolveListen);
    });
    client = new QuoteRendererClient({ socketPath: socket, timeoutMs: 1000 });
  });
  afterEach(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
    await rm(directory, { recursive: true, force: true });
  });
  it("requires native-ready health and caches only a short availability window", async () => {
    expect(await client.available()).toBe(true);
    expect(await client.available()).toBe(true);
    expect(calls).toHaveLength(1);
    expect(await client.render(payload)).toEqual({
      data: webp,
      format: "webp",
      width: 512,
      height: 240,
    });
    expect(calls[1]).toContain(JSON.stringify(payload));
  });
  it("does not accept a broker-only health response", async () => {
    respond = (_request, response) => response.end(JSON.stringify({ ok: true }));
    expect(await client.available()).toBe(false);
  });
  it("does not retry busy renders or duplicate a send-producing request", async () => {
    respond = (_request, response) => {
      response.writeHead(409);
      response.end();
    };
    await expect(client.render(payload)).rejects.toMatchObject({ code: "busy" });
    expect(calls).toHaveLength(1);
  });
  it("cancels an in-flight request", async () => {
    const controller = new AbortController();
    respond = () => controller.abort();
    await expect(client.render(payload, controller.signal)).rejects.toMatchObject({
      code: "cancelled",
    });
    expect(calls).toHaveLength(1);
  });
  it.each([
    ["image/webp", "513", "240", webp],
    ["image/png", "512", "240", Buffer.from("not-image")],
    ["image/webp", "512", "240", Buffer.alloc(512 * 1024 + 1)],
    ["image/jpeg", "512", "240", webp],
  ])("rejects invalid output %s %s %s", async (mime, width, height, bytes) => {
    respond = (_request, response) => {
      response.writeHead(200, {
        "content-type": mime,
        "x-quote-width": width,
        "x-quote-height": height,
      });
      response.end(bytes);
    };
    await expect(client.render(payload)).rejects.toMatchObject({ code: "render_failed" });
  });
});
