import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, open, readdir, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { MediaAudioStore } from "./audio-store.js";

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, open: vi.fn(actual.open), unlink: vi.fn(actual.unlink) };
});

function pcm(seconds = 1) {
  const wav = Buffer.alloc(44 + seconds * 32000);
  wav.write("RIFF");
  wav.writeUInt32LE(wav.length - 8, 4);
  wav.write("WAVEfmt ", 8);
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(16000, 24);
  wav.writeUInt32LE(32000, 28);
  wav.writeUInt16LE(2, 32);
  wav.writeUInt16LE(16, 34);
  wav.write("data", 36);
  wav.writeUInt32LE(seconds * 32000, 40);
  return wav;
}

it.each(["remove", "sweep"] as const)(
  "%s continues after concurrent deletion but propagates permission errors",
  async (operation) => {
    const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
    const root = await mkdtemp(join(tmpdir(), "audio-remove-race-"));
    const directory = join(root, "asr-audio");
    const id = randomUUID();
    const first = join(directory, `${id}.1000000000.wav`);
    const second = join(directory, `${id}.1000000001.wav`);
    try {
      await mkdir(directory, { mode: 0o700 });
      await writeFile(first, "synthetic");
      await writeFile(second, "synthetic");
      const store = new MediaAudioStore(root, "https://bot.example.com", "synthetic-key");
      const cleanup = () => (operation === "remove" ? store.remove(id) : store.sweep());
      const failure = Object.assign(new Error("synthetic permission failure"), { code: "EACCES" });
      vi.mocked(unlink).mockRejectedValueOnce(failure);
      await expect(cleanup()).rejects.toBe(failure);
      expect(await readdir(directory)).toHaveLength(2);
      vi.mocked(unlink).mockImplementationOnce(async (path) => {
        await actual.unlink(path);
        await actual.unlink(path);
      });
      await cleanup();
      expect(await readdir(directory)).toEqual([]);
    } finally {
      vi.mocked(unlink).mockReset();
      await rm(root, { recursive: true, force: true });
    }
  },
);

it("releases the source descriptor even when closing the staged file fails", async () => {
  const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
  const directory = await mkdtemp(join(tmpdir(), "audio-close-failure-"));
  const sourcePath = join(directory, "source.wav");
  const wav = pcm();
  await writeFile(sourcePath, wav);
  const handles: Awaited<ReturnType<typeof open>>[] = [];
  const closeError = new Error("injected close failure");
  vi.mocked(open).mockImplementation(async (...args) => {
    const handle = await actual.open(...args);
    handles.push(handle);
    if (String(args[0]) !== sourcePath) {
      const close = handle.close.bind(handle);
      vi.spyOn(handle, "close").mockImplementation(async () => {
        await close();
        throw closeError;
      });
    }
    return handle;
  });
  try {
    const store = new MediaAudioStore(
      join(directory, "staged"),
      "https://bot.example.com",
      "synthetic-signing-key",
    );
    await expect(store.stageFile(randomUUID(), sourcePath)).rejects.toBe(closeError);
    expect(handles).toHaveLength(2);
    await expect(handles[0]!.stat()).rejects.toMatchObject({ code: "EBADF" });
  } finally {
    vi.restoreAllMocks();
    vi.mocked(open).mockImplementation(actual.open);
    await Promise.all(handles.map((handle) => handle.close().catch(() => undefined)));
    await rm(directory, { recursive: true, force: true });
  }
});

it("removes a partially copied audio file and closes both handles when cancelled", async () => {
  const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
  const directory = await mkdtemp(join(tmpdir(), "audio-copy-cancel-"));
  const sourcePath = join(directory, "source.wav");
  const wav = pcm(3);
  const handles: Awaited<ReturnType<typeof open>>[] = [];
  const controller = new AbortController();
  const cancelled = new Error("synthetic copy cancellation");
  let copiedBytes = 0;
  try {
    await writeFile(sourcePath, wav);
    vi.mocked(open).mockImplementation(async (...args) => {
      const handle = await actual.open(...args);
      handles.push(handle);
      if (String(args[0]) !== sourcePath) {
        const write = handle.write.bind(handle);
        vi.spyOn(handle, "write").mockImplementation(async (...args) => {
          const result = await write(...args);
          copiedBytes = (await handle.stat()).size;
          controller.abort(cancelled);
          return result;
        });
      }
      return handle;
    });
    const store = new MediaAudioStore(directory, "https://bot.example.com", "synthetic-key");
    await expect(store.stageFile(randomUUID(), sourcePath, {}, controller.signal)).rejects.toBe(
      cancelled,
    );
    expect(copiedBytes).toBeGreaterThan(0);
    expect(copiedBytes).toBeLessThan(wav.length);
    expect(await actual.readFile(sourcePath)).toEqual(wav);
    expect(await readdir(join(directory, "asr-audio"))).toEqual([]);
    expect(handles).toHaveLength(2);
    for (const handle of handles)
      await expect(handle.stat()).rejects.toMatchObject({ code: "EBADF" });
  } finally {
    vi.restoreAllMocks();
    vi.mocked(open).mockImplementation(actual.open);
    await Promise.all(handles.map((handle) => handle.close().catch(() => undefined)));
    await rm(directory, { recursive: true, force: true });
  }
});
