import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { appendFileSync, truncateSync } from "node:fs";
import {
  mkdtemp,
  mkdir,
  readFile,
  writeFile,
  rm,
  symlink,
  link,
  lstat,
  truncate,
  open,
  rename,
  readdir,
} from "node:fs/promises";
import { request } from "node:http";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createWorker, MediaWorkerError, runProcess } from "./server.mjs";

const SECRET = "synthetic-media-worker-secret-123456789";
const exec = promisify(execFile);
let root, worker, job, input, checksum, spawnProcess, latestChild;
let stalled, failed, overflow, inputDuration, outputDuration, codec, outputSize, outputFifo;

function http(
  path,
  {
    method = "GET",
    body,
    authorization = `Bearer ${SECRET}`,
    socketPath = join(root, "worker.sock"),
  } = {},
) {
  return new Promise((resolve, reject) => {
    const req = request(
      {
        socketPath,
        path,
        method,
        headers: {
          authorization,
          ...(body === undefined ? {} : { "content-type": "application/json" }),
        },
      },
      (res) => {
        const chunks = [];
        res.on("data", (chunk) => chunks.push(chunk));
        res.on("end", () =>
          resolve({ status: res.statusCode, body: JSON.parse(Buffer.concat(chunks).toString()) }),
        );
      },
    );
    req.on("error", reject);
    req.end(
      body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body),
    );
  });
}

function conversion(extra = {}) {
  return http(`/jobs/${job}/convert`, {
    method: "POST",
    body: { sha256: checksum, maxDurationSeconds: 10, ...extra },
  });
}

function mockSpawn(binary, args, _options) {
  const child = Object.assign(new EventEmitter(), {
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    kill: vi.fn(() => {
      queueMicrotask(() => child.emit("close", null));
      return true;
    }),
  });
  latestChild = child;
  void Promise.resolve()
    .then(async () => {
      if (binary === "ffmpeg") {
        if (outputFifo) {
          await rm(args.at(-1));
          await exec("mkfifo", [args.at(-1)]);
        } else await writeFile(args.at(-1), Buffer.alloc(outputSize));
      }
      if (binary === stalled) return;
      if (binary === failed) {
        child.stderr.write("provider Authorization: secret-cookie /private/provider-url");
        child.emit("close", 1);
        return;
      }
      if (binary === overflow) child.stderr.write(Buffer.alloc(65_537));
      else if (binary === "ffprobe") {
        const output = args.includes("wav");
        child.stdout.write(
          JSON.stringify({
            streams: [
              {
                codec_type: "audio",
                codec_name: output ? "pcm_s16le" : codec,
                duration: String(output ? outputDuration : inputDuration),
                sample_rate: "16000",
                channels: 1,
              },
            ],
            format: { duration: String(inputDuration) },
          }),
        );
      }
      child.emit("close", 0);
    })
    .catch((error) => child.emit("error", error));
  return child;
}

beforeEach(async () => {
  root = await mkdtemp("/private/tmp/media-worker-test-");
  job = randomUUID();
  await mkdir(join(root, "jobs", job), { recursive: true });
  input = join(root, "jobs", job, "input.m4a");
  const bytes = Buffer.alloc(24);
  bytes.writeUInt32BE(24);
  bytes.write("ftyp", 4);
  bytes.write("M4A ", 8);
  await writeFile(input, bytes);
  checksum = createHash("sha256").update(bytes).digest("hex");
  stalled = failed = overflow = undefined;
  inputDuration = outputDuration = 1;
  codec = "aac";
  outputSize = 64;
  outputFifo = false;
  spawnProcess = vi.fn(mockSpawn);
  worker = createWorker({
    socketPath: join(root, "worker.sock"),
    jobDirectory: join(root, "jobs"),
    secret: SECRET,
    spawnProcess,
  });
  await worker.start();
});

afterEach(async () => {
  await worker?.close();
  vi.restoreAllMocks();
  await rm(root, { recursive: true, force: true });
});

describe("isolated media worker protocol", () => {
  it("requires a strong worker secret", () => {
    expect(() => createWorker({ secret: "short" })).toThrow(MediaWorkerError);
    expect(() => createWorker({ secret: "" })).toThrow("invalid_secret");
  });

  it("authenticates before validating paths, bodies or opening job files", async () => {
    for (const authorization of ["", "Bearer wrong", `Basic ${SECRET}`]) {
      const result = await http("/jobs/../secret/convert", {
        method: "POST",
        authorization,
        body: "private",
      });
      expect(result).toEqual({ status: 401, body: { ok: false, error: "unauthorized" } });
    }
    expect(spawnProcess).not.toHaveBeenCalled();
    expect(await http("/health")).toEqual({ status: 200, body: { ok: true } });
    expect((await lstat(join(root, "worker.sock"))).mode & 0o777).toBe(0o660);
  });

  it.each([
    "/jobs/../convert",
    "/jobs/%2e%2e/convert",
    "/jobs/not-a-uuid/convert",
    "/jobs/00000000-0000-0000-0000-000000000000/convert?url=https://example.com",
    "/input.m4a",
  ])("rejects arbitrary paths %s", async (path) => {
    expect((await http(path, { method: "POST", body: {} })).status).toBe(404);
    expect(spawnProcess).not.toHaveBeenCalled();
  });

  it.each([
    {},
    { sha256: "a".repeat(64), maxDurationSeconds: 0 },
    { sha256: "a".repeat(64), maxDurationSeconds: 601 },
    { sha256: "a".repeat(64), maxDurationSeconds: 1.5 },
    { sha256: "A".repeat(64), maxDurationSeconds: 10 },
    { sha256: "a".repeat(64) + "\n", maxDurationSeconds: 10 },
    { sha256: "a".repeat(64), maxDurationSeconds: 10, sourceUrl: "https://example.com/private" },
    "not-json",
    " ".repeat(1025),
  ])("rejects invalid or oversized conversion requests", async (body) => {
    expect(await http(`/jobs/${job}/convert`, { method: "POST", body })).toEqual({
      status: 400,
      body: { ok: false, error: "invalid_request" },
    });
    expect(spawnProcess).not.toHaveBeenCalled();
  });

  it("returns bounded converted metadata and uses only fixed local-file process arguments", async () => {
    const result = await conversion();
    expect(result).toEqual({
      status: 200,
      body: {
        ok: true,
        bytes: outputSize,
        sha256: createHash("sha256").update(Buffer.alloc(outputSize)).digest("hex"),
        durationSeconds: 1,
      },
    });
    expect(spawnProcess.mock.calls.map(([binary]) => binary)).toEqual([
      "ffprobe",
      "ffmpeg",
      "ffprobe",
    ]);
    for (const [_binary, args, options] of spawnProcess.mock.calls) {
      expect(options).toMatchObject({ shell: false, stdio: ["ignore", "pipe", "pipe"] });
      expect(options.env).not.toHaveProperty("MEDIA_WORKER_SECRET");
      expect(options.env).not.toHaveProperty("DATABASE_URL");
      expect(args).toEqual(
        expect.arrayContaining(["-protocol_whitelist", "file", "-threads", "1"]),
      );
      expect(args.some((arg) => arg.startsWith("http:"))).toBe(false);
    }
    const args = spawnProcess.mock.calls.find(([binary]) => binary === "ffmpeg")[1];
    expect(args).toEqual(
      expect.arrayContaining([
        "-f",
        "mov",
        "-enable_drefs",
        "0",
        "-use_absolute_path",
        "0",
        "-map",
        "0:a:0",
        "-vn",
        "-sn",
        "-dn",
        "-ac",
        "1",
        "-ar",
        "16000",
        "-c:a",
        "pcm_s16le",
        "-fs",
        "20971520",
        "-t",
        "11",
      ]),
    );
    expect(await readFile(input)).toHaveLength(24);
  });

  it("rejects checksum mismatch before launching a decoder", async () => {
    expect((await conversion({ sha256: "b".repeat(64) })).body.error).toBe("checksum_mismatch");
    expect(spawnProcess).not.toHaveBeenCalled();
  });

  it("rejects MP4 impostors even with a matching checksum", async () => {
    const bytes = Buffer.from("#EXTM3U\nhttps://private/audio\n");
    await writeFile(input, bytes);
    checksum = createHash("sha256").update(bytes).digest("hex");
    expect((await conversion()).body.error).toBe("invalid_input");
    expect(spawnProcess).not.toHaveBeenCalled();
  });

  it("requires exact MP4 magic bytes rather than ASCII high-bit aliases", async () => {
    const bytes = await readFile(input);
    for (let index = 4; index < 8; index++) bytes[index] |= 0x80;
    await writeFile(input, bytes);
    checksum = createHash("sha256").update(bytes).digest("hex");
    expect((await conversion()).body.error).toBe("invalid_input");
    expect(spawnProcess).not.toHaveBeenCalled();
  });

  it("rejects an input FIFO promptly and leaves the worker available", async () => {
    await rm(input);
    await exec("mkfifo", [input]);
    expect(await conversion()).toEqual({
      status: 400,
      body: { ok: false, error: "invalid_input" },
    });
    expect(spawnProcess).not.toHaveBeenCalled();
    expect((await http(`/jobs/${job}`, { method: "DELETE" })).status).toBe(404);
    expect((await http("/health")).status).toBe(200);
  }, 2000);

  it.each(["grows", "shrinks"])("rejects input that %s during its bounded hash", async (change) => {
    const file = await open(input, "r");
    const prototype = Object.getPrototypeOf(file);
    await file.close();
    const original = prototype.createReadStream;
    vi.spyOn(prototype, "createReadStream").mockImplementationOnce(function (options) {
      if (change === "grows") appendFileSync(input, "changed");
      else truncateSync(input, 16);
      return original.call(this, options);
    });
    expect((await conversion()).body.error).toBe("invalid_input");
    expect(spawnProcess).not.toHaveBeenCalled();
  });

  it("cancels a stalled file hash and releases its descriptor and active slot", async () => {
    const file = await open(input, "r");
    const prototype = Object.getPrototypeOf(file);
    await file.close();
    const original = prototype.createReadStream;
    const streams = vi
      .spyOn(prototype, "createReadStream")
      .mockImplementationOnce(function (options) {
        const stream = original.call(this, options);
        // Stall disk reads while preserving the real stream's AbortSignal and descriptor lifecycle.
        stream._read = () => undefined;
        return stream;
      });
    const pending = conversion();
    await vi.waitFor(() => expect(streams).toHaveBeenCalledOnce());
    expect((await http(`/jobs/${job}`, { method: "DELETE" })).status).toBe(200);
    expect(await pending).toEqual({ status: 409, body: { ok: false, error: "cancelled" } });
    expect(spawnProcess).not.toHaveBeenCalled();
    expect((await conversion()).status).toBe(200);
  }, 2000);

  it("rejects symlinked job directories and symlinked/hardlinked input files", async () => {
    await rm(input);
    await writeFile(join(root, "outside"), Buffer.alloc(24));
    await symlink(join(root, "outside"), input);
    expect((await conversion()).status).toBe(400);
    await rm(input);
    await link(join(root, "outside"), input);
    expect((await conversion()).body.error).toBe("invalid_input");
    await rm(join(root, "jobs", job), { recursive: true });
    await mkdir(join(root, "outside-job"));
    await symlink(join(root, "outside-job"), join(root, "jobs", job));
    expect((await conversion()).body.error).toBe("invalid_job");
    expect(spawnProcess).not.toHaveBeenCalled();
  });

  it("bounds input size before hashing or probing", async () => {
    await truncate(input, 64 * 1024 * 1024 + 1);
    expect((await conversion()).body.error).toBe("invalid_input");
    expect(spawnProcess).not.toHaveBeenCalled();
  });

  it.each([0, -1, 10.1, 601, NaN])(
    "rejects invalid or excessive input duration %s",
    async (duration) => {
      inputDuration = duration;
      expect((await conversion()).status).toBe(400);
      expect(spawnProcess.mock.calls.map(([binary]) => binary)).toEqual(["ffprobe"]);
    },
  );

  it("rejects unsupported audio codecs", async () => {
    codec = "mp3";
    expect((await conversion()).body.error).toBe("unsupported_codec");
    expect(spawnProcess).toHaveBeenCalledOnce();
  });

  it.each([0.1, 1.3, 10.1])(
    "rejects output duration mismatch or excess %s and removes only output",
    async (duration) => {
      outputDuration = duration;
      expect((await conversion()).body.error).toBe("duration_limit");
      await expect(lstat(join(root, "jobs", job, "output.wav"))).rejects.toMatchObject({
        code: "ENOENT",
      });
      expect((await lstat(input)).isFile()).toBe(true);
    },
  );

  it("rejects oversized output and removes partial output", async () => {
    outputSize = 20 * 1024 * 1024 + 1;
    expect((await conversion()).body.error).toBe("invalid_output");
    await expect(lstat(join(root, "jobs", job, "output.wav"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("rejects a FIFO substituted for converted output and cleans it without blocking", async () => {
    outputFifo = true;
    expect(await conversion()).toEqual({
      status: 400,
      body: { ok: false, error: "invalid_output" },
    });
    await expect(lstat(join(root, "jobs", job, "output.wav"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    expect((await lstat(input)).isFile()).toBe(true);
    outputFifo = false;
    expect((await conversion()).status).toBe(200);
  }, 2000);

  it("never overwrites an existing output symlink or file", async () => {
    await writeFile(join(root, "outside"), "preserved");
    await symlink(join(root, "outside"), join(root, "jobs", job, "output.wav"));
    expect((await conversion()).body.error).toBe("invalid_job");
    expect(await readFile(join(root, "outside"), "utf8")).toBe("preserved");
    expect(spawnProcess.mock.calls.some(([binary]) => binary === "ffmpeg")).toBe(false);
  });

  it("returns busy without queuing, and DELETE waits for cancellation/partial-output cleanup", async () => {
    stalled = "ffmpeg";
    const pending = conversion();
    await vi.waitFor(() =>
      expect(spawnProcess.mock.calls.some(([binary]) => binary === "ffmpeg")).toBe(true),
    );
    expect(await conversion()).toEqual({ status: 409, body: { ok: false, error: "busy" } });
    expect(await http(`/jobs/${randomUUID()}`, { method: "DELETE" })).toMatchObject({
      status: 404,
    });
    const child = latestChild;
    expect(await http(`/jobs/${job}`, { method: "DELETE" })).toEqual({
      status: 200,
      body: { ok: true },
    });
    expect(await pending).toEqual({ status: 409, body: { ok: false, error: "cancelled" } });
    expect(child.kill).toHaveBeenCalledWith("SIGKILL");
    await expect(lstat(join(root, "jobs", job, "output.wav"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    stalled = undefined;
    expect((await conversion()).status).toBe(200);
  });

  it("shutdown kills and waits for the active subprocess and removes its socket and partial output", async () => {
    stalled = "ffmpeg";
    const pending = conversion().catch(() => undefined);
    await vi.waitFor(() =>
      expect(spawnProcess.mock.calls.some(([binary]) => binary === "ffmpeg")).toBe(true),
    );
    const child = latestChild;
    await worker.close();
    await pending;
    expect(child.kill).toHaveBeenCalledWith("SIGKILL");
    await expect(lstat(join(root, "worker.sock"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(lstat(join(root, "jobs", job, "output.wav"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("disconnecting a conversion client cancels and cleans the active process", async () => {
    stalled = "ffmpeg";
    const req = request({
      socketPath: join(root, "worker.sock"),
      path: `/jobs/${job}/convert`,
      method: "POST",
      headers: { authorization: `Bearer ${SECRET}` },
    });
    req.on("error", () => undefined);
    req.end(JSON.stringify({ sha256: checksum, maxDurationSeconds: 10 }));
    await vi.waitFor(() =>
      expect(spawnProcess.mock.calls.some(([binary]) => binary === "ffmpeg")).toBe(true),
    );
    const child = latestChild;
    req.destroy();
    await vi.waitFor(() => expect(child.kill).toHaveBeenCalledWith("SIGKILL"));
    await vi.waitFor(async () =>
      expect((await http(`/jobs/${job}`, { method: "DELETE" })).status).toBe(404),
    );
    await expect(lstat(join(root, "jobs", job, "output.wav"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("cancels a job even while its client has not finished sending the request body", async () => {
    const req = request({
      socketPath: join(root, "worker.sock"),
      path: `/jobs/${job}/convert`,
      method: "POST",
      headers: { authorization: `Bearer ${SECRET}`, "transfer-encoding": "chunked" },
    });
    req.on("error", () => undefined);
    req.write('{"sha256":');
    await vi.waitFor(async () => expect((await conversion()).status).toBe(409));
    expect((await http(`/jobs/${job}`, { method: "DELETE" })).status).toBe(200);
    req.destroy();
    expect(spawnProcess).not.toHaveBeenCalled();
  });

  it.each(["ffprobe", "ffmpeg"])(
    "redacts failed %s stderr and cleans any partial output",
    async (binary) => {
      failed = binary;
      const result = await conversion();
      expect(result).toEqual({ status: 400, body: { ok: false, error: "conversion_failed" } });
      expect(JSON.stringify(result)).not.toContain("secret-cookie");
      await expect(lstat(join(root, "jobs", job, "output.wav"))).rejects.toMatchObject({
        code: "ENOENT",
      });
    },
  );

  it("kills a subprocess producing more than 64 KiB diagnostic output", async () => {
    overflow = "ffmpeg";
    const result = await conversion();
    expect(result.body.error).toBe("process_output_limit");
    expect(latestChild.kill).toHaveBeenCalledWith("SIGKILL");
  });

  it("enforces the shared 120-second job deadline independently of child deadlines", async () => {
    const timers = vi.spyOn(globalThis, "setTimeout");
    stalled = "ffmpeg";
    const pending = conversion();
    await vi.waitFor(() =>
      expect(spawnProcess.mock.calls.some(([binary]) => binary === "ffmpeg")).toBe(true),
    );
    expect(timers.mock.calls.some(([, milliseconds]) => milliseconds === 15_000)).toBe(true);
    const expireJob = timers.mock.calls.find(([, milliseconds]) => milliseconds === 120_000)[0];
    expireJob();
    expect(await pending).toEqual({ status: 504, body: { ok: false, error: "timeout" } });
    expect(latestChild.kill).toHaveBeenCalledWith("SIGKILL");
    await expect(lstat(join(root, "jobs", job, "output.wav"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("reclaims a stale socket left by an exited worker", async () => {
    await worker.close();
    const socketPath = join(root, "worker.sock");
    await exec(process.execPath, [
      "--input-type=module",
      "-e",
      "import {createServer} from 'node:net'; const server=createServer(); server.listen(process.argv[1],()=>process.exit(0));",
      socketPath,
    ]);
    expect((await lstat(socketPath)).isSocket()).toBe(true);
    worker = createWorker({
      socketPath,
      jobDirectory: join(root, "jobs"),
      secret: SECRET,
      spawnProcess,
    });
    await worker.start();
    expect((await http("/health")).status).toBe(200);
  });

  it("does not clobber a live worker socket or a regular file at the socket path", async () => {
    const duplicate = createWorker({
      socketPath: join(root, "worker.sock"),
      jobDirectory: join(root, "jobs"),
      secret: SECRET,
    });
    await expect(duplicate.start()).rejects.toThrow("socket_unavailable");
    await duplicate.close();
    expect((await http("/health")).status).toBe(200);
    const socketPath = join(root, "regular-file");
    await writeFile(socketPath, "preserved");
    const invalid = createWorker({ socketPath, jobDirectory: join(root, "jobs"), secret: SECRET });
    await expect(invalid.start()).rejects.toThrow("socket_unavailable");
    await invalid.close();
    expect(await readFile(socketPath, "utf8")).toBe("preserved");
  });

  it("does not unlink a replacement worker's public socket when closing", async () => {
    const socketPath = join(root, "worker.sock");
    await rename(socketPath, join(root, "old.sock"));
    const replacement = createWorker({
      socketPath,
      jobDirectory: join(root, "jobs"),
      secret: SECRET,
    });
    try {
      await replacement.start();
      const identity = await lstat(socketPath);
      await worker.close();
      expect((await http("/health")).status).toBe(200);
      expect((await lstat(socketPath)).ino).toBe(identity.ino);
    } finally {
      await replacement.close();
    }
  });

  it("publishes exactly one socket during competing starts without leftover private aliases", async () => {
    const socketPath = join(root, "competing.sock");
    const workers = Array.from({ length: 2 }, () =>
      createWorker({ socketPath, jobDirectory: join(root, "jobs"), secret: SECRET }),
    );
    try {
      const results = await Promise.allSettled(workers.map((candidate) => candidate.start()));
      expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
      expect(results.find((result) => result.status === "rejected").reason).toMatchObject({
        code: "socket_unavailable",
      });
      expect((await http("/health", { socketPath })).status).toBe(200);
      expect((await readdir(root)).some((entry) => entry.startsWith(".worker-"))).toBe(false);
    } finally {
      await Promise.all(workers.map((candidate) => candidate.close()));
    }
    await expect(lstat(socketPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("applies subprocess timeouts and waits for close after kill", async () => {
    stalled = "ffprobe";
    const controller = new AbortController();
    const pending = runProcess("ffprobe", [], {
      signal: controller.signal,
      timeoutMs: 20,
      spawnProcess,
    });
    await expect(pending).rejects.toMatchObject({ code: "timeout" });
    expect(latestChild.kill).toHaveBeenCalledWith("SIGKILL");
  });

  it("converts real synthetic AAC MP4 to mono 16 kHz PCM using the installed binaries", async (context) => {
    try {
      await exec("ffmpeg", ["-version"]);
      await exec("ffprobe", ["-version"]);
    } catch {
      context.skip("FFmpeg/ffprobe binaries are unavailable");
      return;
    }
    await worker.close();
    worker = createWorker({
      socketPath: join(root, "worker.sock"),
      jobDirectory: join(root, "jobs"),
      secret: SECRET,
    });
    await worker.start();
    await exec("ffmpeg", [
      "-hide_banner",
      "-v",
      "error",
      "-nostdin",
      "-y",
      "-f",
      "lavfi",
      "-i",
      "sine=frequency=440:duration=0.5",
      "-c:a",
      "aac",
      "-f",
      "mp4",
      input,
    ]);
    checksum = createHash("sha256")
      .update(await readFile(input))
      .digest("hex");
    const result = await conversion();
    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({
      ok: true,
      durationSeconds: expect.any(Number),
      sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    const output = await readFile(join(root, "jobs", job, "output.wav"));
    expect(result.body.bytes).toBe(output.length);
    expect(result.body.sha256).toBe(createHash("sha256").update(output).digest("hex"));
    expect(output.toString("ascii", 0, 4)).toBe("RIFF");
    expect(output.toString("ascii", 8, 12)).toBe("WAVE");
    expect(result.body.durationSeconds).toBeGreaterThan(0.4);
    expect(result.body.durationSeconds).toBeLessThan(0.75);
  }, 15_000);
});
