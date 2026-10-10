import { mkdtemp, open, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { FileTooLargeError, readFileBounded } from "./file-reader.js";

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, open: vi.fn(actual.open) };
});
afterEach(() => vi.restoreAllMocks());

it.each(["", "notes", "字幕🙂"])(
  "preserves complete bytes at the exact limit: %j",
  async (text) => {
    const directory = await mkdtemp(join(tmpdir(), "bounded-file-"));
    try {
      const file = join(directory, "notes.md");
      const content = Buffer.from(text);
      await writeFile(file, content);
      expect(await readFileBounded(file, content.length)).toEqual(content);
      if (content.length)
        await expect(readFileBounded(file, content.length - 1)).rejects.toBeInstanceOf(
          FileTooLargeError,
        );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  },
);

it("bounds bytes read when a file grows after stat and closes before rejecting", async () => {
  let requested = 0;
  const close = vi.fn(async () => {});
  const read = vi.fn(async (buffer: Buffer, offset: number, length: number) => {
    requested += length;
    buffer.fill(97, offset, offset + length);
    return { bytesRead: length, buffer };
  });
  vi.mocked(open).mockResolvedValueOnce({
    stat: async () => ({ size: 1 }),
    read,
    close,
  } as unknown as Awaited<ReturnType<typeof open>>);
  await expect(readFileBounded("synthetic", 100_000)).rejects.toBeInstanceOf(FileTooLargeError);
  expect(requested).toBe(100_001);
  expect(read).toHaveBeenCalledTimes(2);
  expect(close).toHaveBeenCalledOnce();
});

it("closes the file and preserves a read failure", async () => {
  const failure = new Error("synthetic read failure");
  const close = vi.fn(async () => {});
  vi.mocked(open).mockResolvedValueOnce({
    stat: async () => ({ size: 1 }),
    read: async () => {
      throw failure;
    },
    close,
  } as unknown as Awaited<ReturnType<typeof open>>);
  await expect(readFileBounded("synthetic", 8)).rejects.toBe(failure);
  expect(close).toHaveBeenCalledOnce();
});

it("reuses buffer space across repeated short reads", async () => {
  let remaining = 512;
  const buffers = new Set<Buffer>();
  const close = vi.fn(async () => {});
  vi.mocked(open).mockResolvedValueOnce({
    stat: async () => ({ size: 0 }),
    read: async (buffer: Buffer, offset: number) => {
      buffers.add(buffer);
      if (!remaining) return { bytesRead: 0, buffer };
      remaining--;
      buffer[offset] = 97;
      return { bytesRead: 1, buffer };
    },
    close,
  } as unknown as Awaited<ReturnType<typeof open>>);
  expect(await readFileBounded("synthetic", 100_000)).toEqual(Buffer.alloc(512, 97));
  expect(buffers.size).toBe(1);
  expect(close).toHaveBeenCalledOnce();
});

it.each(["stat", "size", "read"])(
  "waits for the native handle to close before reporting a %s failure",
  async (stage) => {
    const directory = await mkdtemp(join(tmpdir(), "bounded-file-close-"));
    const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
    let releaseClose!: () => void;
    const closing = new Promise<void>((resolve) => {
      releaseClose = resolve;
    });
    let markClosing!: () => void;
    const enteredClose = new Promise<void>((resolve) => {
      markClosing = resolve;
    });
    let pending: Promise<unknown> | undefined;
    let handle: Awaited<ReturnType<typeof open>> | undefined;
    try {
      const file = join(directory, "notes.md");
      await writeFile(file, "ok");
      handle = await actual.open(file, "r");
      const nativeClose = handle.close.bind(handle);
      const failure = new Error(`synthetic ${stage} failure`);
      if (stage === "stat") vi.spyOn(handle, "stat").mockRejectedValueOnce(failure);
      if (stage === "read") vi.spyOn(handle, "read").mockRejectedValueOnce(failure);
      const close = vi.spyOn(handle, "close").mockImplementation(async () => {
        markClosing();
        await closing;
        await nativeClose();
      });
      vi.mocked(open).mockResolvedValueOnce(handle);
      let settled = false;
      pending = readFileBounded(file, stage === "size" ? 1 : 2).then(
        (value) => {
          settled = true;
          return value;
        },
        (error: unknown) => {
          settled = true;
          return error;
        },
      );
      await enteredClose;
      expect(settled).toBe(false);
      releaseClose();
      const result = await pending;
      if (stage === "size") expect(result).toBeInstanceOf(FileTooLargeError);
      else expect(result).toBe(failure);
      expect(close).toHaveBeenCalledOnce();
      await expect(handle.stat()).rejects.toMatchObject({ code: "EBADF" });
    } finally {
      releaseClose();
      await pending;
      await handle?.close();
      await rm(directory, { recursive: true, force: true });
    }
  },
);
