// Dependency-free HTTP bridge that lets the harness run allowlisted `lody` commands in a
// glibc sidecar with a local Lody daemon. Logs carry only the subcommand, exit status, and
// duration: never argv values, stdin (prompts), tokens, or stdout.
import { spawn } from "node:child_process";
import { createHash, timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";
import { pathToFileURL } from "node:url";
import { checkArgs } from "./allowlist.mjs";

const MAX_BODY_BYTES = 512 * 1024;
const MAX_STDIN_BYTES = 256 * 1024;
const DEFAULT_MAX_OUTPUT_BYTES = 8 * 1024 * 1024;
const DEFAULT_MAX_TIMEOUT_MS = 180_000;
const MIN_SECRET_LENGTH = 32;
const KILL_GRACE_MS = 2_000;

function digest(value) {
  return createHash("sha256").update(value).digest();
}

/** Compares fixed-length digests so neither content nor length leaks through timing. */
export function authorized(header, secret) {
  if (typeof header !== "string" || !header.startsWith("Bearer ")) return false;
  return timingSafeEqual(digest(header.slice(7)), digest(secret));
}

function send(res, status, body) {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(text),
    "cache-control": "no-store",
  });
  res.end(text);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(Object.assign(new Error("body too large"), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

/**
 * Runs one command. The result mirrors what `execFile` would report so the harness keeps one
 * classification: exit code, signal, timeout, output overflow, or a spawn error code.
 */
export function runLody(command, args, { stdin, timeoutMs, maxOutputBytes }) {
  return new Promise((resolve) => {
    const [file, ...prefix] = command;
    let stdout = "";
    let bytes = 0;
    let timedOut = false;
    let truncated = false;
    let settled = false;
    const child = spawn(file, [...prefix, ...args], {
      stdio: ["pipe", "pipe", "ignore"],
      env: { ...process.env, LODY_CLI_TOKEN: undefined, HARNESS_LODY_BRIDGE_SECRET: undefined },
    });
    const kill = () => {
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), KILL_GRACE_MS).unref();
    };
    const timer = setTimeout(() => {
      timedOut = true;
      kill();
    }, timeoutMs);
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    child.stdout.on("data", (chunk) => {
      bytes += chunk.length;
      if (bytes > maxOutputBytes) {
        truncated = true;
        kill();
        return;
      }
      stdout += chunk.toString("utf8");
    });
    child.on("error", (error) => finish({ spawnError: error.code ?? "ESPAWN" }));
    child.on("close", (exitCode, signal) =>
      finish({ exitCode, signal, timedOut, truncated, stdout: truncated ? "" : stdout }),
    );
    child.stdin.on("error", () => {});
    child.stdin.end(stdin ?? "");
  });
}

export function createBridgeServer(options) {
  const {
    secret,
    command = ["lody"],
    maxTimeoutMs = DEFAULT_MAX_TIMEOUT_MS,
    maxOutputBytes = DEFAULT_MAX_OUTPUT_BYTES,
    log = (line) => process.stdout.write(`${line}\n`),
  } = options;
  if (typeof secret !== "string" || secret.length < MIN_SECRET_LENGTH) {
    throw new Error(`HARNESS_LODY_BRIDGE_SECRET must be at least ${MIN_SECRET_LENGTH} characters`);
  }
  let version = null;

  return createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://bridge");
    if (req.method === "GET" && url.pathname === "/health") {
      version ??= await runLody(command, ["--version"], {
        timeoutMs: 10_000,
        maxOutputBytes: 4096,
      }).then((result) => (result.exitCode === 0 ? result.stdout.trim().slice(0, 40) : null));
      send(res, 200, { ok: true, lody: version });
      return;
    }
    if (req.method !== "POST" || url.pathname !== "/exec") {
      send(res, 404, { ok: false, error: "not found" });
      return;
    }
    if (!authorized(req.headers.authorization, secret)) {
      log("lody-bridge: rejected unauthenticated request");
      send(res, 401, { ok: false, error: "unauthorized" });
      return;
    }
    let body;
    try {
      body = JSON.parse(await readBody(req));
    } catch (error) {
      send(res, error.status ?? 400, { ok: false, error: "invalid body" });
      return;
    }
    const checked = checkArgs(body?.args);
    if (!checked.ok) {
      log(`lody-bridge: rejected args (${checked.error})`);
      send(res, 400, { ok: false, error: checked.error });
      return;
    }
    const stdin = typeof body.stdin === "string" ? body.stdin : undefined;
    if (
      stdin !== undefined &&
      (!checked.readsStdin || Buffer.byteLength(stdin) > MAX_STDIN_BYTES)
    ) {
      send(res, 400, { ok: false, error: "stdin only with --prompt-file - and at most 256 KiB" });
      return;
    }
    const requested = Number(body.timeoutMs);
    const timeoutMs = Math.min(
      maxTimeoutMs,
      Math.max(1_000, Number.isFinite(requested) ? requested : maxTimeoutMs),
    );
    const started = Date.now();
    const result = await runLody(command, body.args, { stdin, timeoutMs, maxOutputBytes });
    log(
      `lody-bridge: ${checked.command} -> ${
        result.spawnError ?? (result.timedOut ? "timeout" : (result.signal ?? result.exitCode))
      } in ${Date.now() - started}ms`,
    );
    send(res, 200, result);
  });
}

function commandFromEnv(value) {
  if (!value) return ["lody"];
  const parsed = JSON.parse(value);
  if (
    !Array.isArray(parsed) ||
    parsed.length === 0 ||
    !parsed.every((s) => typeof s === "string")
  ) {
    throw new Error("LODY_BRIDGE_COMMAND must be a JSON array of strings");
  }
  return parsed;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const port = Number(process.env.LODY_BRIDGE_PORT ?? 43190);
  const server = createBridgeServer({
    secret: process.env.HARNESS_LODY_BRIDGE_SECRET,
    command: commandFromEnv(process.env.LODY_BRIDGE_COMMAND),
  });
  delete process.env.HARNESS_LODY_BRIDGE_SECRET;
  server.listen(port, "0.0.0.0", () => process.stdout.write(`lody-bridge: listening on ${port}\n`));
  const stop = () => server.close(() => process.exit(0));
  process.once("SIGTERM", stop);
  process.once("SIGINT", stop);
}
