import { lookup } from "node:dns/promises";
import {
  createServer,
  request as httpRequest,
  type IncomingMessage,
  type RequestOptions,
  type Server,
} from "node:http";
import { request as httpsRequest } from "node:https";
import { afterEach, expect, it, vi } from "vitest";
import { readMediaDocument } from "./http.js";

vi.mock("node:dns/promises", () => ({ lookup: vi.fn() }));
vi.mock("node:https", () => ({ request: vi.fn() }));

let server: Server | undefined;
afterEach(async () => {
  vi.resetAllMocks();
  if (!server) return;
  server.closeAllConnections();
  await new Promise<void>((resolve) => server!.close(() => resolve()));
  server = undefined;
});

it.each(["too_large", "cancel", "timeout"] as const)(
  "closes the native response connection after %s",
  async (mode) => {
    let closed = false;
    let sawBody!: () => void;
    const bodyStarted = new Promise<void>((resolve) => {
      sawBody = resolve;
    });
    const paths: string[] = [];
    server = createServer((req, res) => {
      paths.push(req.url!);
      res.once("close", () => {
        closed = true;
      });
      res.writeHead(200, { "Content-Type": "application/json" });
      res.write(mode === "too_large" ? "x".repeat(65) : '{"pending":');
      // Keep the body open so only client-side cleanup can close this connection.
    });
    await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Missing test address");
    vi.mocked(lookup).mockResolvedValue([{ address: "8.8.8.8", family: 4 }] as never);
    // Exercise real request/IncomingMessage cancellation locally, without testing TLS or DNS pinning.
    vi.mocked(httpsRequest).mockImplementation(((
      options: RequestOptions,
      callback: (response: IncomingMessage) => void,
    ) =>
      httpRequest(
        {
          hostname: "127.0.0.1",
          port: address.port,
          path: options.path,
          method: options.method,
          headers: options.headers,
          agent: false,
          signal: options.signal,
        },
        (response) => {
          response.once("readable", sawBody);
          callback(response);
        },
      )) as typeof httpsRequest);

    const controller = new AbortController();
    const reason = new Error("Synthetic media cancellation");
    const reading = readMediaDocument("https://api.example.com/stream", {
      allowedHosts: ["api.example.com"],
      mimeTypes: ["application/json"],
      maxBytes: 64,
      timeoutMs: mode === "timeout" ? 1000 : 5000,
      signal: controller.signal,
    }).catch((error: unknown) => error);
    await bodyStarted;
    if (mode === "cancel") controller.abort(reason);
    const result = await reading;
    if (mode === "cancel") expect(result).toBe(reason);
    else expect(result).toMatchObject({ code: mode });
    await expect.poll(() => closed).toBe(true);
    expect(paths).toEqual(["/stream"]);
  },
);
