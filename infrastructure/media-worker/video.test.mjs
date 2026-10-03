import { execFile, spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  truncate,
  writeFile,
} from "node:fs/promises";
import { request } from "node:http";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createWorker } from "./server.mjs";

const exec = promisify(execFile);
const SECRET = "synthetic-video-worker-secret-123456789";
let root, directory, worker, job, hashes, processes, slowMux;
function http(path, method = "POST", body) {
  return new Promise((resolve, reject) => {
    const req = request(
      {
        socketPath: join(root, "worker.sock"),
        path,
        method,
        headers: { authorization: `Bearer ${SECRET}` },
      },
      (res) => {
        const chunks = [];
        res.on("data", (chunk) => chunks.push(chunk));
        res.on("end", () =>
          resolve({ status: res.statusCode, body: JSON.parse(Buffer.concat(chunks)) }),
        );
      },
    );
    req.on("error", reject);
    req.end(body === undefined ? undefined : JSON.stringify(body));
  });
}
function mux(extra = {}) {
  return http(`/jobs/${job}/mux-video`, "POST", {
    ...hashes,
    maxDurationSeconds: 5,
    maxBytes: 45_000_000,
    ...extra,
  });
}
async function assertClean() {
  await expect(lstat(join(directory, "output.mp4"))).rejects.toMatchObject({ code: "ENOENT" });
  expect((await lstat(join(directory, "video.mp4"))).isFile()).toBe(true);
}

beforeEach(async () => {
  root = await mkdtemp("/private/tmp/video-mux-");
  job = randomUUID();
  directory = join(root, "jobs", "video-downloads", job);
  await mkdir(directory, { recursive: true });
  await exec("ffmpeg", [
    "-v",
    "error",
    "-nostdin",
    "-f",
    "lavfi",
    "-i",
    "color=c=blue:s=160x90:r=25:d=0.5",
    "-c:v",
    "libx264",
    "-pix_fmt",
    "yuv420p",
    "-an",
    join(directory, "video.mp4"),
  ]);
  await exec("ffmpeg", [
    "-v",
    "error",
    "-nostdin",
    "-f",
    "lavfi",
    "-i",
    "sine=frequency=440:duration=0.5",
    "-c:a",
    "aac",
    "-vn",
    join(directory, "audio.m4a"),
  ]);
  hashes = {
    videoSha256: createHash("sha256")
      .update(await readFile(join(directory, "video.mp4")))
      .digest("hex"),
    audioSha256: createHash("sha256")
      .update(await readFile(join(directory, "audio.m4a")))
      .digest("hex"),
  };
  await chmod(join(directory, "video.mp4"), 0o440);
  await chmod(join(directory, "audio.m4a"), 0o440);
  processes = [];
  slowMux = false;
  worker = createWorker({
    socketPath: join(root, "worker.sock"),
    jobDirectory: join(root, "jobs"),
    secret: SECRET,
    spawnProcess: (binary, args, options) => {
      const actual = [...args];
      if (slowMux && binary === "ffmpeg") actual.splice(actual.indexOf("-i"), 0, "-re");
      const child = spawn(binary, actual, options);
      processes.push({ binary, args, options, child });
      return child;
    },
  });
  await worker.start();
});
afterEach(async () => {
  await worker?.close();
  await rm(root, { recursive: true, force: true });
});

describe("real FFmpeg network-free AVC/AAC mux", () => {
  it("merges complete AVC/AAC tracks with faststart and verifies output hash", async () => {
    const result = await mux();
    expect(result.status).toBe(200);
    const output = await readFile(join(directory, "output.mp4"));
    expect(result.body.bytes).toBe(output.length);
    expect(result.body.sha256).toBe(createHash("sha256").update(output).digest("hex"));
    expect(result.body.durationSeconds).toBeGreaterThan(0.4);
    expect(result.body.durationSeconds).toBeLessThan(0.75);
    expect(output.indexOf(Buffer.from("moov"))).toBeLessThan(output.indexOf(Buffer.from("mdat")));
    for (const { args, options } of processes) {
      expect(args).toEqual(expect.arrayContaining(["-protocol_whitelist", "file"]));
      expect(args.some((value) => /^https?:/.test(value))).toBe(false);
      expect(options).toMatchObject({ shell: false, stdio: ["ignore", "pipe", "pipe"] });
      expect(options.env).not.toHaveProperty("MEDIA_WORKER_SECRET");
    }
    const command = processes.find(({ binary }) => binary === "ffmpeg").args;
    expect(command).toEqual(
      expect.arrayContaining(["-c", "copy", "-map", "0:v:0", "1:a:0", "-movflags", "+faststart"]),
    );
    expect(command).not.toContain("-fs");
  });

  it("rejects byte excess and deletes output instead of returning a truncated MP4", async () => {
    expect((await mux({ maxBytes: 100 })).status).toBe(400);
    await assertClean();
  });

  it("kills the actual FFmpeg process on DELETE and waits for partial-output cleanup", async () => {
    slowMux = true;
    const pending = mux();
    await vi.waitFor(() => expect(processes.some(({ binary }) => binary === "ffmpeg")).toBe(true));
    const process = processes.find(({ binary }) => binary === "ffmpeg").child;
    expect((await http(`/jobs/${job}`, "DELETE")).status).toBe(200);
    expect((await pending).body.error).toBe("cancelled");
    expect(process.signalCode).toBe("SIGKILL");
    await assertClean();
  });

  it("rejects checksum mismatch before launching any media process", async () => {
    expect((await mux({ audioSha256: "a".repeat(64) })).body.error).toBe("checksum_mismatch");
    expect(processes).toHaveLength(0);
  });

  it("rejects symlinked input and leaves the outside file untouched", async () => {
    const input = join(directory, "video.mp4");
    const outside = join(root, "outside.mp4");
    await writeFile(outside, await readFile(input));
    await rm(input);
    await symlink(outside, input);
    expect((await mux()).body.error).toBe("invalid_job");
    expect(processes).toHaveLength(0);
    expect((await readFile(outside)).length).toBeGreaterThan(16);
  });

  it("rejects combined input bytes over64MiB before any decoding", async () => {
    await chmod(join(directory, "video.mp4"), 0o600);
    await chmod(join(directory, "audio.m4a"), 0o600);
    await truncate(join(directory, "video.mp4"), 33 * 1024 * 1024);
    await truncate(join(directory, "audio.m4a"), 33 * 1024 * 1024);
    hashes.videoSha256 = createHash("sha256")
      .update(await readFile(join(directory, "video.mp4")))
      .digest("hex");
    hashes.audioSha256 = createHash("sha256")
      .update(await readFile(join(directory, "audio.m4a")))
      .digest("hex");
    expect((await mux()).body.error).toBe("invalid_input");
    expect(processes).toHaveLength(0);
  });

  it("rejects URLs, traversal, excess bounds, and forged body fields without launching FFmpeg", async () => {
    expect((await http("/jobs/../mux-video", "POST", hashes)).status).toBe(404);
    expect((await mux({ maxBytes: 50_000_001 })).body.error).toBe("invalid_request");
    expect((await mux({ input: "https://private.example/input.mp4" })).body.error).toBe(
      "invalid_request",
    );
    expect(processes).toHaveLength(0);
  });

  it("rejects a playlist masquerading as an MP4 before any process can access its URL", async () => {
    const bytes = Buffer.from("#EXTM3U\nhttps://169.254.169.254/secret\n");
    await chmod(join(directory, "video.mp4"), 0o600);
    await writeFile(join(directory, "video.mp4"), bytes);
    hashes.videoSha256 = createHash("sha256").update(bytes).digest("hex");
    expect((await mux()).body.error).toBe("invalid_input");
    expect(processes).toHaveLength(0);
  });
});
