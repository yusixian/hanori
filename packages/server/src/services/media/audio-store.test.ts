import { randomUUID } from "node:crypto";
import { mkdtemp, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { asrAudioRoutes } from "../../routes/asr-audio.js";
import { MediaAudioStore } from "./audio-store.js";

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
