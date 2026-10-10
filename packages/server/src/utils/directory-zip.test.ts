import { randomBytes } from "node:crypto";
import type { ReadStream } from "node:fs";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { createDirectoryZip } from "./directory-zip.js";

const state = vi.hoisted(() => ({
  sources: [] as ReadStream[],
  missing: false,
  finalizeFailure: false,
}));
vi.mock("node:fs", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:fs")>();
  return {
    ...original,
    createReadStream: (file: string) => {
      const source = original.createReadStream(state.missing ? `${file}.missing` : file);
      state.sources.push(source);
      return source;
    },
  };
});
vi.mock("archiver", async (importOriginal) => {
  const original = await importOriginal<{ default: typeof import("archiver") }>();
  return {
    default: (...args: Parameters<typeof original.default>) => {
      const archive = original.default(...args);
      if (state.finalizeFailure)
        archive.finalize = () => Promise.reject(new Error("finalize failed"));
      return archive;
    },
  };
});
let directory = "";
afterEach(async () => {
  for (const source of state.sources) source.destroy();
  if (directory) await rm(directory, { recursive: true, force: true });
  directory = "";
  state.sources = [];
  state.missing = false;
  state.finalizeFailure = false;
});
async function fixture() {
  directory = await mkdtemp(join(tmpdir(), "directory-zip-"));
  return directory;
}

it("closes the active file and never opens queued files after cancellation", async () => {
  const dir = await fixture();
  await writeFile(join(dir, "a.md"), randomBytes(8 * 1024 * 1024));
  await writeFile(join(dir, "b.md"), "must not open");
  const reader = (await createDirectoryZip(dir)).getReader();
  expect((await reader.read()).done).toBe(false);
  expect(state.sources).toHaveLength(1);
  await reader.cancel();
  await vi.waitFor(() => expect(state.sources[0]!.closed).toBe(true));
  expect(state.sources).toHaveLength(1);
  expect(state.sources[0]!.bytesRead).toBeLessThan(8 * 1024 * 1024);
});

it("delivers source open errors through the response body and closes the source", async () => {
  const dir = await fixture();
  await writeFile(join(dir, "notes.md"), "synthetic");
  state.missing = true;
  const response = new Response(await createDirectoryZip(dir));
  await expect(response.arrayBuffer()).rejects.toMatchObject({ code: "ENOENT" });
  await vi.waitFor(() => expect(state.sources.every((source) => source.closed)).toBe(true));
});

it("does not open any source if directory traversal fails", async () => {
  const dir = await fixture();
  const file = join(dir, "notes.md");
  await writeFile(file, "synthetic");
  await expect(createDirectoryZip(file)).rejects.toMatchObject({ code: "ENOTDIR" });
  expect(state.sources).toHaveLength(0);
});

it("keeps nested files, symbolic links, exclusions and empty archives", async () => {
  const dir = await fixture();
  const empty = Buffer.from(await new Response(await createDirectoryZip(dir)).arrayBuffer());
  expect(empty.readUInt32LE(0)).toBe(0x06054b50);
  await mkdir(join(dir, "nested"));
  await writeFile(join(dir, "nested", "notes.md"), "synthetic");
  await writeFile(join(dir, "excluded.exe"), "excluded");
  await symlink("nested/notes.md", join(dir, "link.md"));
  const archive = Buffer.from(await new Response(await createDirectoryZip(dir)).arrayBuffer());
  expect(archive.includes(Buffer.from("nested/notes.md"))).toBe(true);
  expect(archive.includes(Buffer.from("link.md"))).toBe(true);
  expect(archive.includes(Buffer.from("excluded.exe"))).toBe(false);
  await vi.waitFor(() => expect(state.sources.every((source) => source.closed)).toBe(true));
});

it("delivers finalization rejection through the response body", async () => {
  const dir = await fixture();
  state.finalizeFailure = true;
  const response = new Response(await createDirectoryZip(dir));
  await expect(response.arrayBuffer()).rejects.toThrow("finalize failed");
});

it("does not scan or open files when the request is already aborted", async () => {
  const dir = await fixture();
  const controller = new AbortController();
  controller.abort();
  await expect(createDirectoryZip(join(dir, "missing"), controller.signal)).rejects.toMatchObject({
    name: "AbortError",
  });
  expect(state.sources).toHaveLength(0);
});

it("closes the active source when the request signal aborts", async () => {
  const dir = await fixture();
  await writeFile(join(dir, "a.md"), randomBytes(8 * 1024 * 1024));
  await writeFile(join(dir, "b.md"), "must not open");
  const controller = new AbortController();
  const reader = (await createDirectoryZip(dir, controller.signal)).getReader();
  await reader.read();
  controller.abort();
  await expect(
    (async () => {
      while (!(await reader.read()).done) {
        /* Drain already-buffered chunks until the error arrives. */
      }
    })(),
  ).rejects.toMatchObject({ name: "AbortError" });
  await vi.waitFor(() => expect(state.sources[0]!.closed).toBe(true));
  expect(state.sources).toHaveLength(1);
});
