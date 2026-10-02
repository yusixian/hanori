import { spawn } from "node:child_process";
import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, chmod, unlink, link } from "node:fs/promises";
import { createServer } from "node:http";
import { connect } from "node:net";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const INPUT_LIMIT = 64 * 1024 * 1024;
const OUTPUT_LIMIT = 20 * 1024 * 1024;
const PROCESS_OUTPUT_LIMIT = 65_536;
const JOB_TIMEOUT = 120_000;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$(?![\s\S])/;
const SHA256 = /^[a-f0-9]{64}$(?![\s\S])/;

export class MediaWorkerError extends Error {
  constructor(code) {
    super(code);
    this.code = code;
    this.name = "MediaWorkerError";
  }
}

function fail(code) {
  throw new MediaWorkerError(code);
}

function checkAbort(signal) {
  if (signal.aborted)
    throw signal.reason instanceof MediaWorkerError
      ? signal.reason
      : new MediaWorkerError("cancelled");
}

async function safeDirectory(path, create = false) {
  const parent = dirname(path);
  if (parent !== path) await safeDirectory(parent, create);
  if (create)
    await mkdir(path, { mode: 0o750 }).catch((error) => {
      if (error.code !== "EEXIST") throw error;
    });
  const stat = await lstat(path);
  if (!stat.isDirectory() || stat.isSymbolicLink()) fail("invalid_job");
}

async function missing(path) {
  try {
    await lstat(path);
    return false;
  } catch (error) {
    if (error.code === "ENOENT") return true;
    throw error;
  }
}

async function hashFile(file, stat, signal, errorCode) {
  const hash = createHash("sha256");
  let bytes = 0;
  for await (const chunk of file.createReadStream({
    start: 0,
    end: stat.size - 1,
    autoClose: false,
    signal,
  })) {
    checkAbort(signal);
    bytes += chunk.length;
    hash.update(chunk);
  }
  checkAbort(signal);
  const current = await file.stat();
  checkAbort(signal);
  if (
    bytes !== stat.size ||
    !current.isFile() ||
    current.nlink !== 1 ||
    current.size !== stat.size ||
    current.mtimeMs !== stat.mtimeMs ||
    current.ctimeMs !== stat.ctimeMs
  )
    fail(errorCode);
  return hash.digest("hex");
}

async function readVerifiedInput(path, digest, signal) {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.nlink !== 1 || stat.size < 16 || stat.size > INPUT_LIMIT)
      fail("invalid_input");
    const header = Buffer.alloc(16);
    const { bytesRead } = await file.read(header, 0, header.length, 0);
    if (
      bytesRead !== header.length ||
      !header.subarray(4, 8).equals(Buffer.from("ftyp")) ||
      header.readUInt32BE(0) < 16 ||
      header.readUInt32BE(0) > stat.size
    )
      fail("invalid_input");
    if ((await hashFile(file, stat, signal, "invalid_input")) !== digest) fail("checksum_mismatch");
  } finally {
    await file.close();
  }
}

/** FFmpeg gets no host credentials, shell, stdin, network URLs, or ambient process environment. */
export async function runProcess(binary, args, { signal, timeoutMs, spawnProcess = spawn }) {
  checkAbort(signal);
  return new Promise((resolveOutput, reject) => {
    const child = spawnProcess(binary, args, {
      shell: false,
      detached: process.platform !== "win32",
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        PATH: "/usr/bin:/bin:/usr/local/bin:/opt/homebrew/bin",
        LANG: "C",
        HOME: "/nonexistent",
      },
    });
    let failure;
    let closed = false;
    let bytes = 0;
    const output = [];
    const kill = (error) => {
      if (closed) return;
      failure ??= error;
      try {
        if (child.pid && process.platform !== "win32") process.kill(-child.pid, "SIGKILL");
        else child.kill("SIGKILL");
      } catch {
        child.kill("SIGKILL");
      }
    };
    const onAbort = () =>
      kill(
        signal.reason instanceof MediaWorkerError
          ? signal.reason
          : new MediaWorkerError("cancelled"),
      );
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) onAbort();
    const timer = setTimeout(() => kill(new MediaWorkerError("timeout")), timeoutMs);
    const collect = (chunk, stdout) => {
      bytes += chunk.length;
      if (bytes > PROCESS_OUTPUT_LIMIT) kill(new MediaWorkerError("process_output_limit"));
      else if (stdout) output.push(chunk);
    };
    child.stdout.on("data", (chunk) => collect(chunk, true));
    child.stderr.on("data", (chunk) => collect(chunk, false));
    child.on("error", () => {
      failure ??= new MediaWorkerError("conversion_failed");
    });
    child.on("close", (code) => {
      closed = true;
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      if (failure) reject(failure);
      else if (code !== 0) reject(new MediaWorkerError("conversion_failed"));
      else resolveOutput(Buffer.concat(output).toString("utf8"));
    });
  });
}

function probeArgs(path, demuxer) {
  return [
    "-hide_banner",
    "-v",
    "error",
    "-threads",
    "1",
    "-protocol_whitelist",
    "file",
    ...(demuxer === "mov" ? ["-enable_drefs", "0", "-use_absolute_path", "0"] : []),
    "-f",
    demuxer,
    "-select_streams",
    "a:0",
    "-show_entries",
    "format=duration:stream=codec_name,codec_type,duration,sample_rate,channels",
    "-of",
    "json",
    "-i",
    path,
  ];
}

async function probe(path, demuxer, signal, spawnProcess) {
  const output = await runProcess("ffprobe", probeArgs(path, demuxer), {
    signal,
    timeoutMs: 15_000,
    spawnProcess,
  });
  let result;
  try {
    result = JSON.parse(output);
  } catch {
    fail("invalid_audio");
  }
  if (
    !Array.isArray(result.streams) ||
    result.streams.length !== 1 ||
    result.streams[0]?.codec_type !== "audio"
  )
    fail("invalid_audio");
  const stream = result.streams[0];
  const duration = Number(stream.duration ?? result.format?.duration);
  if (!Number.isFinite(duration) || duration <= 0) fail("invalid_audio");
  return { stream, duration };
}

async function convert(job, body, options, signal) {
  const directory = join(options.jobDirectory, job);
  const input = join(directory, "input.m4a");
  const output = join(directory, "output.wav");
  let outputCreated = false;
  try {
    checkAbort(signal);
    await safeDirectory(directory);
    await readVerifiedInput(input, body.sha256, signal);
    const metadata = await probe(input, "mov", signal, options.spawnProcess);
    if (!["aac", "opus"].includes(metadata.stream.codec_name)) fail("unsupported_codec");
    if (metadata.duration > body.maxDurationSeconds) fail("duration_limit");
    // Reject a known oversized PCM result before -fs could truncate it near the timing tolerance.
    if (Math.ceil(metadata.duration * 32_000) + 44 > OUTPUT_LIMIT) fail("invalid_output");
    checkAbort(signal);
    const handle = await open(
      output,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600,
    );
    outputCreated = true;
    await handle.close();
    await runProcess(
      "ffmpeg",
      [
        "-hide_banner",
        "-v",
        "error",
        "-nostdin",
        "-y",
        "-threads",
        "1",
        "-protocol_whitelist",
        "file",
        "-enable_drefs",
        "0",
        "-use_absolute_path",
        "0",
        "-f",
        "mov",
        "-i",
        input,
        "-map",
        "0:a:0",
        "-vn",
        "-sn",
        "-dn",
        "-threads",
        "1",
        "-ac",
        "1",
        "-ar",
        "16000",
        "-c:a",
        "pcm_s16le",
        "-t",
        String(metadata.duration + 1),
        "-fs",
        String(OUTPUT_LIMIT),
        "-f",
        "wav",
        output,
      ],
      { signal, timeoutMs: JOB_TIMEOUT, spawnProcess: options.spawnProcess },
    );
    checkAbort(signal);
    const converted = await probe(output, "wav", signal, options.spawnProcess);
    if (
      converted.stream.codec_name !== "pcm_s16le" ||
      Number(converted.stream.sample_rate) !== 16000 ||
      converted.stream.channels !== 1
    )
      fail("invalid_output");
    if (
      converted.duration > body.maxDurationSeconds ||
      Math.abs(converted.duration - metadata.duration) > 0.25
    )
      fail("duration_limit");
    const file = await open(
      output,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    try {
      const stat = await file.stat();
      if (!stat.isFile() || stat.nlink !== 1 || stat.size < 44 || stat.size > OUTPUT_LIMIT)
        fail("invalid_output");
      const sha256 = await hashFile(file, stat, signal, "invalid_output");
      return { ok: true, bytes: stat.size, sha256, durationSeconds: converted.duration };
    } finally {
      await file.close();
    }
  } catch (error) {
    if (outputCreated) await unlink(output).catch(() => undefined);
    checkAbort(signal);
    if (error instanceof MediaWorkerError) throw error;
    fail("invalid_job");
  }
}

async function jsonBody(request, signal) {
  checkAbort(signal);
  const data = await new Promise((resolveBody, reject) => {
    const chunks = [];
    let bytes = 0;
    const cleanup = () => {
      request.removeListener("data", onData);
      request.removeListener("end", onEnd);
      request.removeListener("error", onError);
      signal.removeEventListener("abort", onAbort);
    };
    const onError = () => {
      cleanup();
      reject(new MediaWorkerError("invalid_request"));
    };
    const onAbort = () => {
      cleanup();
      reject(
        signal.reason instanceof MediaWorkerError
          ? signal.reason
          : new MediaWorkerError("cancelled"),
      );
    };
    const onData = (chunk) => {
      bytes += chunk.length;
      if (bytes > 1024) {
        cleanup();
        reject(new MediaWorkerError("invalid_request"));
        return;
      }
      chunks.push(chunk);
    };
    const onEnd = () => {
      cleanup();
      resolveBody(Buffer.concat(chunks));
    };
    request.on("data", onData);
    request.once("end", onEnd);
    request.once("error", onError);
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) onAbort();
  });
  let body;
  try {
    body = JSON.parse(data.toString("utf8"));
  } catch {
    fail("invalid_request");
  }
  if (
    !body ||
    typeof body !== "object" ||
    Array.isArray(body) ||
    Object.keys(body).some((key) => !["sha256", "maxDurationSeconds"].includes(key)) ||
    typeof body.sha256 !== "string" ||
    !SHA256.test(body.sha256) ||
    !Number.isSafeInteger(body.maxDurationSeconds) ||
    body.maxDurationSeconds < 1
  )
    fail("invalid_request");
  return body;
}

function send(response, status, body) {
  if (response.destroyed || response.writableEnded) return;
  response.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
  response.end(JSON.stringify(body));
}

async function unlinkOwnedSocket(path, identity) {
  if (!identity) return;
  const current = await lstat(path).catch(() => undefined);
  if (current?.isSocket() && current.ino === identity.ino && current.dev === identity.dev)
    await unlink(path).catch(() => undefined);
}

async function socketInUse(path) {
  return new Promise((resolveInUse, reject) => {
    const client = connect(path);
    const finish = (value) => {
      client.destroy();
      resolveInUse(value);
    };
    client.once("connect", () => finish(true));
    client.once("error", (error) => {
      if (error.code === "ECONNREFUSED" || error.code === "ENOENT") finish(false);
      else {
        client.destroy();
        reject(new MediaWorkerError("socket_unavailable"));
      }
    });
    client.setTimeout(1000, () => finish(true));
  });
}

/** This transport/conversion broker requires the separate OS/container isolation configured by its caller. */
export function createWorker({
  socketPath = process.env.MEDIA_WORKER_SOCKET ?? "/media-control/worker.sock",
  jobDirectory = process.env.MEDIA_JOB_DIR ?? "/media-jobs",
  secret = process.env.MEDIA_WORKER_SECRET,
  spawnProcess = spawn,
} = {}) {
  if (typeof secret !== "string" || !/^[A-Za-z0-9_+/=-]{32,256}$/.test(secret))
    fail("invalid_secret");
  const options = {
    socketPath: resolve(socketPath),
    jobDirectory: resolve(jobDirectory),
    spawnProcess,
  };
  const expected = createHash("sha256").update(`Bearer ${secret}`).digest();
  const boundSocketPath = join(dirname(options.socketPath), `.worker-${randomUUID()}.sock`);
  let active;
  let stopped = false;
  let socketIdentity;
  const server = createServer(async (request, response) => {
    const header =
      typeof request.headers.authorization === "string" ? request.headers.authorization : "";
    if (!timingSafeEqual(expected, createHash("sha256").update(header).digest())) {
      send(response, 401, { ok: false, error: "unauthorized" });
      return;
    }
    const path = request.url ?? "";
    if (request.method === "GET" && path === "/health") {
      send(response, stopped ? 503 : 200, { ok: !stopped });
      return;
    }
    const match = /^\/jobs\/([^/]+)(\/convert)?$(?![\s\S])/.exec(path);
    if (!match || !UUID.test(match[1])) {
      send(response, 404, { ok: false, error: "not_found" });
      return;
    }
    const job = match[1];
    if (request.method === "DELETE" && !match[2]) {
      if (!active || active.job !== job) {
        send(response, 404, { ok: false, error: "not_found" });
        return;
      }
      active.controller.abort(new MediaWorkerError("cancelled"));
      await active.done;
      send(response, 200, { ok: true });
      return;
    }
    if (request.method !== "POST" || !match[2]) {
      send(response, 404, { ok: false, error: "not_found" });
      return;
    }
    if (stopped) {
      send(response, 503, { ok: false, error: "worker_stopped" });
      return;
    }
    if (active) {
      send(response, 409, { ok: false, error: "busy" });
      return;
    }
    const controller = new AbortController();
    let finished;
    const done = new Promise((resolveDone) => {
      finished = resolveDone;
    });
    const current = { job, controller, done };
    active = current;
    const timer = setTimeout(() => controller.abort(new MediaWorkerError("timeout")), JOB_TIMEOUT);
    const disconnect = () => {
      if (!response.writableEnded) controller.abort(new MediaWorkerError("cancelled"));
    };
    request.once("aborted", disconnect);
    response.once("close", disconnect);
    try {
      const body = await jsonBody(request, controller.signal);
      checkAbort(controller.signal);
      send(response, 200, await convert(job, body, options, controller.signal));
    } catch (error) {
      const code = error instanceof MediaWorkerError ? error.code : "conversion_failed";
      send(response, code === "cancelled" ? 409 : code === "timeout" ? 504 : 400, {
        ok: false,
        error: code,
      });
    } finally {
      clearTimeout(timer);
      request.removeListener("aborted", disconnect);
      response.removeListener("close", disconnect);
      if (active === current) active = undefined;
      finished();
    }
  });
  server.requestTimeout = JOB_TIMEOUT + 5000;
  server.headersTimeout = 10_000;
  server.keepAliveTimeout = 1000;
  return {
    server,
    async start() {
      if (stopped) fail("worker_stopped");
      await safeDirectory(options.jobDirectory, true);
      await safeDirectory(dirname(options.socketPath), true);
      if (!(await missing(options.socketPath))) {
        const stat = await lstat(options.socketPath);
        if (!stat.isSocket() || (await socketInUse(options.socketPath))) fail("socket_unavailable");
        const current = await lstat(options.socketPath);
        if (current.ino !== stat.ino || current.dev !== stat.dev) fail("socket_unavailable");
        await unlink(options.socketPath);
      }
      try {
        // libuv unlinks its binding on close. Publish an alias so it cannot delete a replacement
        // at the public path before our inode check, and link atomically to avoid competing starts.
        await new Promise((resolveStarted, reject) => {
          const onError = () => reject(new MediaWorkerError("socket_unavailable"));
          server.once("error", onError);
          server.listen(boundSocketPath, () => {
            server.removeListener("error", onError);
            resolveStarted();
          });
        });
        const identity = await lstat(boundSocketPath);
        await chmod(boundSocketPath, 0o660);
        await link(boundSocketPath, options.socketPath);
        socketIdentity = identity;
        await unlink(boundSocketPath);
      } catch {
        server.closeAllConnections();
        if (server.listening) await new Promise((resolveClosed) => server.close(resolveClosed));
        await unlinkOwnedSocket(options.socketPath, socketIdentity);
        fail("socket_unavailable");
      }
    },
    async close() {
      stopped = true;
      if (active) {
        active.controller.abort(new MediaWorkerError("cancelled"));
        await active.done;
      }
      server.closeAllConnections();
      if (server.listening) await new Promise((resolveClosed) => server.close(resolveClosed));
      await unlinkOwnedSocket(options.socketPath, socketIdentity);
    },
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const worker = createWorker();
    await worker.start();
    const shutdown = () => {
      void worker.close().then(
        () => process.exit(0),
        () => process.exit(1),
      );
    };
    process.once("SIGTERM", shutdown);
    process.once("SIGINT", shutdown);
  } catch {
    process.stderr.write("media_worker_start_failed\n");
    process.exitCode = 1;
  }
}
