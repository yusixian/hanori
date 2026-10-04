import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { open, type FileHandle } from "node:fs/promises";
import { MAX_ASR_DURATION_SECONDS, MAX_ASR_WAV_BYTES } from "./long-audio.js";

/** Validate the isolated converter's output in the trusted host; worker metadata is not authoritative. */
export function inspectConvertedWav(
  bytes: Buffer,
  maxSeconds: number,
): { durationSeconds: number } {
  const invalid = (): never => {
    throw new Error("invalid_converted_audio");
  };
  if (
    !Number.isFinite(maxSeconds) ||
    maxSeconds <= 0 ||
    bytes.length < 44 ||
    bytes.length > 20 * 1024 * 1024 ||
    !bytes.subarray(0, 4).equals(Buffer.from("RIFF")) ||
    !bytes.subarray(8, 12).equals(Buffer.from("WAVE")) ||
    bytes.readUInt32LE(4) + 8 !== bytes.length
  )
    invalid();
  let offset = 12;
  let format = false;
  let dataBytes = 0;
  let chunks = 0;
  while (offset < bytes.length) {
    if (++chunks > 64 || offset + 8 > bytes.length) invalid();
    const name = bytes.subarray(offset, offset + 4);
    const size = bytes.readUInt32LE(offset + 4);
    const start = offset + 8;
    const end = start + size;
    if (end > bytes.length || end + (size % 2) > bytes.length) invalid();
    if (name.equals(Buffer.from("fmt "))) {
      if (
        format ||
        size < 16 ||
        size > 40 ||
        bytes.readUInt16LE(start) !== 1 ||
        bytes.readUInt16LE(start + 2) !== 1 ||
        bytes.readUInt32LE(start + 4) !== 16_000 ||
        bytes.readUInt32LE(start + 8) !== 32_000 ||
        bytes.readUInt16LE(start + 12) !== 2 ||
        bytes.readUInt16LE(start + 14) !== 16
      )
        invalid();
      format = true;
    } else if (name.equals(Buffer.from("data"))) {
      if (dataBytes || size === 0 || size % 2) invalid();
      dataBytes = size;
    } else if (size > 65_536) invalid();
    offset = end + (size % 2);
  }
  const durationSeconds = dataBytes / 32_000;
  if (!format || !dataBytes || durationSeconds > maxSeconds) invalid();
  return { durationSeconds };
}

export interface WavFileInspectionOptions {
  signal?: AbortSignal;
  expectedSha256?: string;
  expectedBytes?: number;
}

/** Positional, bounded reads keep multi-hour PCM off the trusted host's heap. */
export async function inspectConvertedWavFile(
  source: string | FileHandle,
  maxSeconds: number,
  options: WavFileInspectionOptions = {},
): Promise<{ durationSeconds: number; bytes: number; sha256: string }> {
  const invalid = (): never => {
    throw new Error("invalid_converted_audio");
  };
  let file: FileHandle | undefined;
  try {
    options.signal?.throwIfAborted();
    if (!Number.isFinite(maxSeconds) || maxSeconds <= 0) invalid();
    file =
      typeof source === "string"
        ? await open(source, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
        : source;
    const stat = await file.stat();
    if (
      !stat.isFile() ||
      stat.nlink !== 1 ||
      stat.size < 44 ||
      stat.size > MAX_ASR_WAV_BYTES ||
      (options.expectedBytes !== undefined && options.expectedBytes !== stat.size)
    )
      invalid();
    const read = async (position: number, length: number) => {
      options.signal?.throwIfAborted();
      const bytes = Buffer.alloc(length);
      let offset = 0;
      while (offset < length) {
        options.signal?.throwIfAborted();
        const { bytesRead } = await file!.read(bytes, offset, length - offset, position + offset);
        if (!bytesRead) invalid();
        offset += bytesRead;
      }
      return bytes;
    };
    const header = await read(0, 12);
    if (
      header.toString("latin1", 0, 4) !== "RIFF" ||
      header.toString("latin1", 8, 12) !== "WAVE" ||
      header.readUInt32LE(4) + 8 !== stat.size
    )
      invalid();
    let offset = 12;
    let format = false;
    let dataBytes = 0;
    let chunks = 0;
    let metadataBytes = 0;
    while (offset < stat.size) {
      if (++chunks > 64 || offset + 8 > stat.size) invalid();
      const chunk = await read(offset, 8);
      const name = chunk.toString("latin1", 0, 4);
      const size = chunk.readUInt32LE(4);
      const start = offset + 8;
      const end = start + size;
      if (end + (size % 2) > stat.size) invalid();
      if (name === "fmt ") {
        if (format || size < 16 || size > 40) invalid();
        const fmt = await read(start, 16);
        if (
          fmt.readUInt16LE(0) !== 1 ||
          fmt.readUInt16LE(2) !== 1 ||
          fmt.readUInt32LE(4) !== 16_000 ||
          fmt.readUInt32LE(8) !== 32_000 ||
          fmt.readUInt16LE(12) !== 2 ||
          fmt.readUInt16LE(14) !== 16
        )
          invalid();
        format = true;
      } else if (name === "data") {
        if (dataBytes || !size || size % 2) invalid();
        dataBytes = size;
      } else {
        metadataBytes += size + 8;
        if (size > 65_536 || metadataBytes > 65_536) invalid();
      }
      offset = end + (size % 2);
    }
    const durationSeconds = dataBytes / 32_000;
    if (!format || !dataBytes || durationSeconds > Math.min(maxSeconds, MAX_ASR_DURATION_SECONDS))
      invalid();
    const hash = createHash("sha256");
    const buffer = Buffer.alloc(65_536);
    for (let position = 0; position < stat.size; ) {
      options.signal?.throwIfAborted();
      const { bytesRead } = await file.read(
        buffer,
        0,
        Math.min(buffer.length, stat.size - position),
        position,
      );
      if (!bytesRead) invalid();
      hash.update(buffer.subarray(0, bytesRead));
      position += bytesRead;
    }
    options.signal?.throwIfAborted();
    const after = await file.stat();
    if (
      !after.isFile() ||
      after.nlink !== 1 ||
      after.size !== stat.size ||
      after.ino !== stat.ino ||
      after.dev !== stat.dev ||
      after.mtimeMs !== stat.mtimeMs ||
      after.ctimeMs !== stat.ctimeMs
    )
      invalid();
    const sha256 = hash.digest("hex");
    if (options.expectedSha256 !== undefined && options.expectedSha256 !== sha256) invalid();
    return { durationSeconds, bytes: stat.size, sha256 };
  } catch (error) {
    options.signal?.throwIfAborted();
    if (error instanceof Error && error.message === "invalid_converted_audio") throw error;
    return invalid();
  } finally {
    if (typeof source === "string") await file?.close().catch(() => undefined);
  }
}
