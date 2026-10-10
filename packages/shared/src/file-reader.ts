import { open } from "node:fs/promises";

export class FileTooLargeError extends Error {
  constructor() {
    super("File too large");
    this.name = "FileTooLargeError";
  }
}

/** Bound actual reads, including growth after stat, without reopening the path. */
export async function readFileBounded(
  filePath: string,
  maxBytes: number,
): Promise<Buffer<ArrayBuffer>> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0 || maxBytes >= Number.MAX_SAFE_INTEGER)
    throw new RangeError("Invalid file size limit");
  const file = await open(filePath, "r");
  try {
    if ((await file.stat()).size > maxBytes) throw new FileTooLargeError();
    const chunks: Buffer[] = [];
    let total = 0;
    let chunk = Buffer.allocUnsafe(Math.min(64 * 1024, maxBytes + 1));
    let used = 0;
    while (true) {
      const { bytesRead } = await file.read(chunk, used, chunk.length - used, null);
      if (!bytesRead) {
        if (used) chunks.push(chunk.subarray(0, used));
        return Buffer.concat(chunks, total);
      }
      total += bytesRead;
      if (total > maxBytes) throw new FileTooLargeError();
      used += bytesRead;
      // Short reads fill the same buffer instead of retaining a full allocation per fragment.
      if (used === chunk.length) {
        chunks.push(chunk);
        chunk = Buffer.allocUnsafe(Math.min(64 * 1024, maxBytes + 1 - total));
        used = 0;
      }
    }
  } finally {
    await file.close();
  }
}
