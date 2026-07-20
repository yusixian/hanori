import { createServer } from "node:http";
import { chmod, readFile, rm } from "node:fs/promises";
import { Readable } from "node:stream";
import { createCodingWorkerHandler } from "./worker.js";

const secretFile = "/tmp/coding-worker-secret";
let secret = process.env["CODING_WORKER_SECRET"];
if (!secret && secretFile) {
  try {
    secret = await readFile(secretFile, "utf8");
  } finally {
    await rm(secretFile, { force: true });
  }
}
if (!secret) throw new Error("CODING_WORKER_SECRET is required");
delete process.env["CODING_WORKER_SECRET"];
process.env["GIT_OPTIONAL_LOCKS"] = "0";

const port = Number(process.env["CODING_WORKER_PORT"] ?? "3010");
const socketPath = process.env["CODING_WORKER_SOCKET"];
const workspacesRoot = process.env["CODING_JOB_ROOT"] ?? "/job";
const handler = createCodingWorkerHandler({ secret, workspacesRoot });

if (socketPath) await rm(socketPath, { force: true });

const server = createServer(async (incoming, outgoing) => {
  try {
    const headers = new Headers();
    for (const [name, value] of Object.entries(incoming.headers)) {
      if (Array.isArray(value)) headers.set(name, value.join(", "));
      else if (value !== undefined) headers.set(name, value);
    }
    const request = new Request(`http://coding-worker${incoming.url ?? "/"}`, {
      method: incoming.method,
      headers,
      body:
        incoming.method === "GET" || incoming.method === "HEAD"
          ? undefined
          : (Readable.toWeb(incoming) as ReadableStream),
      duplex: "half",
    } as RequestInit & { duplex: "half" });
    const response = await handler(request);
    const oneShot = response.headers.get("X-Coding-Worker-One-Shot") === "true";
    response.headers.delete("X-Coding-Worker-One-Shot");
    if (oneShot) {
      outgoing.once("finish", () => {
        server.close(() => process.exit(0));
        setTimeout(() => process.exit(0), 1_000).unref();
      });
    }
    outgoing.writeHead(response.status, Object.fromEntries(response.headers));
    if (response.body) Readable.fromWeb(response.body).pipe(outgoing);
    else outgoing.end();
  } catch {
    outgoing.writeHead(500, { "Content-Type": "application/json" });
    outgoing.end(JSON.stringify({ error: "Internal worker error" }));
  }
});

if (socketPath) {
  server.listen(socketPath, async () => {
    await chmod(socketPath, 0o660);
    process.stdout.write(`Coding worker listening on ${socketPath}\n`);
  });
} else {
  server.listen(port, "127.0.0.1", () => {
    process.stdout.write(`Coding worker listening on ${port}\n`);
  });
}
