import archiver from "archiver";
import { once } from "node:events";
import { createReadStream, type ReadStream, type Stats } from "node:fs";
import { lstat, readdir } from "node:fs/promises";
import * as path from "node:path";
import { Readable } from "node:stream";
import { ALLOWED_EXTENSIONS } from "./file-validation.js";

interface Entry {
  filePath: string;
  name: string;
  stats: Stats;
}

/** Own file sources explicitly: archiver.abort() does not close its lazy readers. */
export async function createDirectoryZip(
  directory: string,
  signal?: AbortSignal,
): Promise<ReadableStream> {
  const entries: Entry[] = [];
  const collect = async (dir: string, prefix: string) => {
    signal?.throwIfAborted();
    const children = await readdir(dir, { withFileTypes: true });
    for (const entry of children) {
      signal?.throwIfAborted();
      const filePath = path.join(dir, entry.name);
      const name = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        await collect(filePath, name);
      } else if (ALLOWED_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) {
        let stats: Stats;
        try {
          stats = await lstat(filePath);
        } catch {
          // Match archiver.file's warning-only handling of failed stat operations.
          continue;
        }
        signal?.throwIfAborted();
        if (stats.isSymbolicLink() || stats.isFile()) {
          entries.push({ filePath, name, stats });
        }
      }
    }
  };
  // Finish directory traversal before starting any file readers.
  await collect(directory, "");
  signal?.throwIfAborted();

  const archive = archiver("zip", { zlib: { level: 5 } });
  const cancellation = new AbortController();
  let source: ReadStream | undefined;
  const stop = () => {
    cancellation.abort();
    source?.destroy();
    archive.abort();
  };
  const onAbort = () => {
    stop();
    archive.destroy(new DOMException("ZIP download cancelled", "AbortError"));
  };
  archive.once("close", () => {
    signal?.removeEventListener("abort", onAbort);
    stop();
  });
  archive.once("error", () => {
    stop();
    archive.destroy();
  });
  const body = Readable.toWeb(archive) as ReadableStream;
  signal?.addEventListener("abort", onAbort, { once: true });
  if (signal?.aborted) onAbort();

  const produce = async () => {
    for (const entry of entries) {
      cancellation.signal.throwIfAborted();
      // Enqueue one source at a time so archiver's append() cannot open every file at once.
      const appended = once(archive, "entry", { signal: cancellation.signal });
      let closed: Promise<void> | undefined;
      try {
        if (entry.stats.isSymbolicLink()) {
          // file() stores a symlink entry without opening its target and preserves its metadata.
          archive.file(entry.filePath, { name: entry.name, stats: entry.stats });
        } else {
          source = createReadStream(entry.filePath);
          closed = new Promise<void>((resolve) => source!.once("close", resolve));
          source.once("error", (error) => archive.destroy(error));
          archive.append(source, { name: entry.name, stats: entry.stats });
        }
      } catch (error) {
        archive.destroy(error instanceof Error ? error : new Error(String(error)));
      }
      await appended;
      await closed;
      source = undefined;
    }
    cancellation.signal.throwIfAborted();
    await archive.finalize();
  };
  void produce().catch((error: unknown) => {
    if (!cancellation.signal.aborted)
      archive.destroy(error instanceof Error ? error : new Error(String(error)));
  });
  return body;
}
