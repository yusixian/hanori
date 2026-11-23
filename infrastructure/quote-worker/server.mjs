import { createServer } from "node:http";
import { connect } from "node:net";
import { mkdtemp, writeFile, readFile, rm, chmod, mkdir, lstat, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runProcess } from "../media-worker/server.mjs";

export const QUOTE_REQUEST_LIMIT = 34 * 1024 * 1024;
const OUTPUT_LIMIT = 8 * 1024 * 1024;
const PROBE = {
  background: "#251D3A",
  messages: [{ author: { key: "probe", name: "字体检查" }, text: "中文 日本語 Hello 😀❤️" }],
};

function failure(code) {
  return Object.assign(new Error(code), { code });
}
function sendError(response, status, code) {
  if (response.destroyed || response.writableEnded) return;
  response.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
  response.end(JSON.stringify({ ok: false, error: code }));
}

export async function renderQuote(
  payload,
  signal,
  {
    python = process.env.QUOTE_PYTHON ?? "python3",
    renderer = fileURLToPath(new URL("./renderer.py", import.meta.url)),
    temporaryRoot = tmpdir(),
    timeoutMs = 15_000,
    spawnProcess,
    fontConfig = process.env.QUOTE_FONTCONFIG_FILE,
  } = {},
) {
  const directory = await mkdtemp(join(temporaryRoot, "quote-"));
  try {
    await chmod(directory, 0o700);
    const input = join(directory, "input.json");
    const output = join(directory, "output.bin");
    await writeFile(input, payload, { mode: 0o600 });
    await writeFile(output, "", { mode: 0o600 });
    const raw = await runProcess(
      python,
      [renderer, input, output, ...(fontConfig ? [fontConfig] : [])],
      {
        signal,
        timeoutMs,
        spawnProcess,
        outputPath: output,
        maxBytes: OUTPUT_LIMIT,
      },
    );
    const metadata = JSON.parse(raw);
    const data = await readFile(output);
    if (
      !["webp", "png"].includes(metadata.format) ||
      !Number.isSafeInteger(metadata.width) ||
      !Number.isSafeInteger(metadata.height) ||
      metadata.width <= 0 ||
      metadata.height <= 0 ||
      metadata.width > 512 ||
      metadata.height > 4096 ||
      data.length === 0 ||
      data.length > OUTPUT_LIMIT
    )
      throw failure("invalid_output");
    if (
      metadata.format === "webp" &&
      (Math.max(metadata.width, metadata.height) !== 512 || data.length > 512 * 1024)
    )
      throw failure("invalid_output");
    if (
      metadata.format === "png"
        ? !data.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
        : data.toString("ascii", 0, 4) !== "RIFF" || data.toString("ascii", 8, 12) !== "WEBP"
    )
      throw failure("invalid_output");
    return { data, format: metadata.format, width: metadata.width, height: metadata.height };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

async function readBody(request, signal) {
  const chunks = [];
  let bytes = 0;
  const abort = () => request.destroy(failure("cancelled"));
  signal.addEventListener("abort", abort, { once: true });
  try {
    if (signal.aborted) throw failure("cancelled");
    for await (const chunk of request) {
      bytes += chunk.length;
      if (bytes > QUOTE_REQUEST_LIMIT) throw failure("input_limit");
      chunks.push(chunk);
    }
    return Buffer.concat(chunks);
  } finally {
    signal.removeEventListener("abort", abort);
  }
}

/** Access is restricted by the dedicated shared Unix socket volume, never a TCP listener. */
export function createQuoteWorker({
  socketPath = process.env.QUOTE_WORKER_SOCKET ?? "/quote-control/worker.sock",
  render = renderQuote,
  renderOptions = {},
} = {}) {
  let ready = false;
  let active;
  let closing = false;
  let socketIdentity;
  const startupController = new AbortController();
  let startup;
  const server = createServer(async (request, response) => {
    if (request.method === "GET" && request.url === "/health") {
      response.writeHead(ready && !closing ? 200 : 503, {
        "content-type": "application/json",
        "cache-control": "no-store",
      });
      response.end(JSON.stringify({ ok: ready && !closing, renderer: "pango-cairo", version: 1 }));
      return;
    }
    if (request.method !== "POST" || request.url !== "/render")
      return sendError(response, 404, "not_found");
    if (!ready || closing) return sendError(response, 503, "unavailable");
    if (active) return sendError(response, 409, "busy");
    const controller = new AbortController();
    let finish;
    active = {
      controller,
      done: new Promise((resolveDone) => {
        finish = resolveDone;
      }),
    };
    const timer = setTimeout(() => controller.abort(), 15_000);
    const disconnect = () => {
      if (!response.writableEnded) controller.abort();
    };
    response.once("close", disconnect);
    try {
      const payload = await readBody(request, controller.signal);
      const result = await render(payload, controller.signal, renderOptions);
      if (controller.signal.aborted) throw failure("cancelled");
      response.writeHead(200, {
        "content-type": result.format === "webp" ? "image/webp" : "image/png",
        "content-length": result.data.length,
        "x-quote-width": result.width,
        "x-quote-height": result.height,
        "cache-control": "no-store",
      });
      response.end(result.data);
    } catch (error) {
      sendError(
        response,
        controller.signal.aborted ? 408 : error.code === "input_limit" ? 413 : 422,
        controller.signal.aborted
          ? "cancelled"
          : error.code === "input_limit"
            ? "input_limit"
            : "render_failed",
      );
    } finally {
      clearTimeout(timer);
      response.removeListener("close", disconnect);
      active = undefined;
      finish();
    }
  });
  server.requestTimeout = 16_000;
  server.headersTimeout = 5_000;
  return {
    server,
    async listen() {
      startup = render(
        Buffer.from(JSON.stringify(PROBE)),
        AbortSignal.any([startupController.signal, AbortSignal.timeout(15_000)]),
        renderOptions,
      );
      await startup;
      if (closing) throw failure("cancelled");
      await mkdir(dirname(socketPath), { recursive: true });
      const previous = await lstat(socketPath).catch((error) => {
        if (error.code !== "ENOENT") throw error;
      });
      // Only this non-root worker owns its dedicated socket; a stale socket is removed on restart.
      if (previous) {
        if (!previous.isSocket() || previous.uid !== process.getuid?.())
          throw failure("socket_conflict");
        const inUse = await new Promise((resolveUse, reject) => {
          const client = connect(socketPath);
          client.once("connect", () => {
            client.destroy();
            resolveUse(true);
          });
          client.once("error", (error) => {
            client.destroy();
            if (["ECONNREFUSED", "ENOENT"].includes(error.code)) resolveUse(false);
            else reject(error);
          });
          client.setTimeout(1000, () => {
            client.destroy();
            resolveUse(true);
          });
        });
        if (inUse) throw failure("socket_conflict");
        await unlink(socketPath);
      }
      await new Promise((resolveListen, reject) => {
        server.once("error", reject);
        server.listen(socketPath, resolveListen);
      });
      await chmod(socketPath, 0o660);
      socketIdentity = await lstat(socketPath);
      ready = true;
    },
    async close() {
      closing = true;
      ready = false;
      startupController.abort();
      if (startup) await startup.catch(() => undefined);
      active?.controller.abort();
      if (active) await active.done;
      server.closeAllConnections();
      if (server.listening) await new Promise((resolveClose) => server.close(resolveClose));
      const current = await lstat(socketPath).catch(() => undefined);
      if (current && current.ino === socketIdentity?.ino) await unlink(socketPath);
    },
  };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const worker = createQuoteWorker();
  const close = () => void worker.close().then(() => process.exit(0));
  process.once("SIGTERM", close);
  process.once("SIGINT", close);
  worker.listen().catch(() => {
    console.error("quote_worker_start_failed");
    process.exit(1);
  });
}
