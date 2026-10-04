import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, open, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { asrAudioRoutes } from "../../routes/asr-audio.js";
import { MediaAudioStore } from "./audio-store.js";
import { inspectConvertedWavFile } from "./wav.js";

const key = "synthetic-audio-signing-secret";
let directory: string;
let store: MediaAudioStore;
function pcm() {
  const bytes = Buffer.alloc(32044);
  bytes.write("RIFF");
  bytes.writeUInt32LE(bytes.length - 8, 4);
  bytes.write("WAVEfmt ", 8);
  bytes.writeUInt32LE(16, 16);
  bytes.writeUInt16LE(1, 20);
  bytes.writeUInt16LE(1, 22);
  bytes.writeUInt32LE(16000, 24);
  bytes.writeUInt32LE(32000, 28);
  bytes.writeUInt16LE(2, 32);
  bytes.writeUInt16LE(16, 34);
  bytes.write("data", 36);
  bytes.writeUInt32LE(32000, 40);
  return bytes;
}
function read(url: URL, service = store) {
  return service.read(
    url.pathname.split("/").at(-1)!,
    url.searchParams.get("expires")!,
    url.searchParams.get("signature")!,
  );
}
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "asr-audio-test-"));
  store = new MediaAudioStore(directory, "https://bot.example.com", key);
});

it("stages and streams a two-hour recording without expanding the short Buffer API", async () => {
  const path = join(directory, "long.wav");
  const file = await open(path, "wx", 0o600);
  const header = pcm().subarray(0, 44);
  header.writeUInt32LE(36 + 7200 * 32000, 4);
  header.writeUInt32LE(7200 * 32000, 40);
  await file.write(header);
  await file.truncate(44 + 7200 * 32000);
  await file.close();
  const verified = await inspectConvertedWavFile(path, 18000);
  const id = randomUUID();
  const beforeStage = Math.floor(Date.now() / 1000);
  const url = new URL(
    await store.stageFile(id, path, {
      maxDurationSeconds: 18000,
      expectedBytes: verified.bytes,
      expectedSha256: verified.sha256,
    }),
  );
  expect(Number(url.searchParams.get("expires"))).toBeGreaterThanOrEqual(beforeStage + 86400);
  expect(Number(url.searchParams.get("expires"))).toBeLessThanOrEqual(
    Math.floor(Date.now() / 1000) + 86400,
  );
  expect(await read(url)).toBeNull();
  const restarted = new MediaAudioStore(directory, "https://bot.example.com", key);
  const opened = vi.spyOn(restarted, "openStream");
  const response = await asrAudioRoutes(restarted).request(`/${id}${url.search}`);
  expect(response.status).toBe(200);
  expect(response.headers.get("Content-Length")).toBe(String(verified.bytes));
  const staged = await opened.mock.results[0]!.value;
  await new Promise((resolve) => setTimeout(resolve, 50));
  expect(staged!.stream.bytesRead).toBeLessThanOrEqual(3 * 65536);
  expect(staged!.stream.readableLength).toBeLessThanOrEqual(65536);
  const reader = response.body!.getReader();
  const hash = createHash("sha256");
  let bytes = 0;
  let largestChunk = 0;
  for (;;) {
    const result = await reader.read();
    if (result.done) break;
    bytes += result.value.byteLength;
    largestChunk = Math.max(largestChunk, result.value.byteLength);
    hash.update(result.value);
  }
  expect(bytes).toBe(verified.bytes);
  expect(largestChunk).toBeLessThanOrEqual(65536);
  expect(hash.digest("hex")).toBe(verified.sha256);
  await store.remove(id);
  expect(await readdir(join(directory, "asr-audio"))).toEqual([]);
}, 15000);

it("does not publish forged or cancelled file staging", async () => {
  const path = join(directory, "short.wav");
  await writeFile(path, pcm());
  await expect(
    store.stageFile(randomUUID(), path, { expectedSha256: "0".repeat(64) }),
  ).rejects.toThrow("invalid_converted_audio");
  const controller = new AbortController();
  controller.abort(new Error("test_cancelled"));
  await expect(store.stageFile(randomUUID(), path, {}, controller.signal)).rejects.toThrow(
    "test_cancelled",
  );
  expect(await readdir(directory)).toEqual(["short.wav"]);
});

it("closes the audio file when the HTTP consumer cancels the response", async () => {
  const id = randomUUID();
  const url = new URL(await store.stage(id, pcm()));
  const opened = vi.spyOn(store, "openStream");
  const response = await asrAudioRoutes(store).request(`/${id}${url.search}`);
  const audio = await opened.mock.results[0]!.value;
  await response.body!.cancel();
  await vi.waitFor(() => expect(audio!.stream.closed).toBe(true));
});
afterEach(async () => {
  vi.useRealTimers();
  await rm(directory, { recursive: true, force: true });
});

it("serves only the exact validated signed audio, survives restart, and removes completed artifacts", async () => {
  const id = randomUUID();
  const url = new URL(await store.stage(id, pcm()));
  expect(await read(url, new MediaAudioStore(directory, "https://bot.example.com", key))).toEqual(
    pcm(),
  );
  const app = asrAudioRoutes(store);
  const response = await app.request(`/${id}${url.search}`);
  expect(response.status).toBe(200);
  expect(response.headers.get("Cache-Control")).toBe("no-store");
  expect(response.headers.get("Content-Type")).toBe("audio/wav");
  expect(Buffer.from(await response.arrayBuffer())).toEqual(pcm());
  await store.remove(id);
  expect(await read(url)).toBeNull();
});
it("rejects expired, forged, cross-job and malformed bearer links without revealing files", async () => {
  const url = new URL(await store.stage(randomUUID(), pcm()));
  const forged = new URL(url);
  forged.searchParams.set("signature", "0".repeat(64));
  expect(await read(forged)).toBeNull();
  const other = new URL(url);
  other.pathname = `/api/asr-audio/${randomUUID()}`;
  expect(await read(other)).toBeNull();
  expect(await store.read("../secrets", "1791060000", "0".repeat(64))).toBeNull();
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date((Number(url.searchParams.get("expires")) - 3600) * 1000));
  expect(await read(url, new MediaAudioStore(directory, "https://bot.example.com", key))).toEqual(
    pcm(),
  );
  vi.setSystemTime(new Date((Number(url.searchParams.get("expires")) + 1) * 1000));
  expect(await read(url)).toBeNull();
  await store.sweep();
  expect(await readdir(join(directory, "asr-audio"))).toEqual([]);
});
it("rejects symlinked and modified audio files and unavailable public HTTPS origins", async () => {
  const id = randomUUID();
  const url = new URL(await store.stage(id, pcm()));
  const filename = join(directory, "asr-audio", `${id}.${url.searchParams.get("expires")}.wav`);
  await writeFile(filename, "invalid-wave");
  expect(await read(url)).toBeNull();
  await rm(filename);
  await symlink(join(directory, "outside-secret"), filename);
  expect(await read(url)).toBeNull();
  for (const origin of ["http://localhost:43100", "https://127.0.0.1", "https://bot.internal"])
    await expect(
      new MediaAudioStore(directory, origin, key).stage(randomUUID(), pcm()),
    ).rejects.toThrow("audio_url_unavailable");
  await expect(store.stage(randomUUID(), Buffer.from("invalid"))).rejects.toThrow(
    "invalid_converted_audio",
  );
});
