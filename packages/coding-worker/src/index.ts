import { createServer } from "node:http";
import { readFile, rm } from "node:fs/promises";
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
const workspacesRoot = process.env["CODING_WORKSPACES_DIR"] ?? "/workspaces";
const handler = createCodingWorkerHandler({ secret, workspacesRoot });

createServer(async (incoming, outgoing) => {
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
    outgoing.writeHead(response.status, Object.fromEntries(response.headers));
    if (response.body) Readable.fromWeb(response.body).pipe(outgoing);
    else outgoing.end();
  } catch {
    outgoing.writeHead(500, { "Content-Type": "application/json" });
    outgoing.end(JSON.stringify({ error: "Internal worker error" }));
  }
}).listen(port, "0.0.0.0", () => {
  process.stdout.write(`Coding worker listening on ${port}\n`);
});
