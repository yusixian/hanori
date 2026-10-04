import { mkdtemp, open, rm, symlink, link } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { inspectConvertedWav, inspectConvertedWavFile } from "./wav.js";

function pcm(seconds = 1) {
  const data = Buffer.alloc(44 + seconds * 32_000);
  data.write("RIFF", 0);
  data.writeUInt32LE(data.length - 8, 4);
  data.write("WAVEfmt ", 8);
  data.writeUInt32LE(16, 16);
  data.writeUInt16LE(1, 20);
  data.writeUInt16LE(1, 22);
  data.writeUInt32LE(16_000, 24);
  data.writeUInt32LE(32_000, 28);
  data.writeUInt16LE(2, 32);
  data.writeUInt16LE(16, 34);
  data.write("data", 36);
  data.writeUInt32LE(data.length - 44, 40);
  return data;
}
describe("isolated converter output verification", () => {
  it("accepts complete601s audio only when the user limit allows it", () => {
    const bytes = pcm(601);
    expect(inspectConvertedWav(bytes, 601)).toEqual({ durationSeconds: 601 });
    expect(inspectConvertedWav(bytes, 3600)).toEqual({ durationSeconds: 601 });
    expect(() => inspectConvertedWav(bytes, 600)).toThrow("invalid_converted_audio");
  });
  it.each([0, -1, NaN, Infinity])("rejects an invalid duration bound %s", (limit) => {
    expect(() => inspectConvertedWav(pcm(), limit)).toThrow("invalid_converted_audio");
  });
  it("retains the20MiB resource bound even with a larger configured duration", () => {
    expect(() => inspectConvertedWav(pcm(656), 3600)).toThrow("invalid_converted_audio");
  });
  it("derives duration from mono16k signed PCM data", () =>
    expect(inspectConvertedWav(pcm(), 10)).toEqual({ durationSeconds: 1 }));
  it("rejects a worker's falsely short duration or non-PCM format", () => {
    expect(() => inspectConvertedWav(pcm(2), 1)).toThrow();
    const bytes = pcm();
    bytes.writeUInt16LE(3, 20);
    expect(() => inspectConvertedWav(bytes, 10)).toThrow();
  });
  it.each([22, 24, 28, 32, 34])("rejects forged PCM parameters at %s", (offset) => {
    const bytes = pcm();
    bytes.writeUInt16LE(0, offset);
    expect(() => inspectConvertedWav(bytes, 10)).toThrow();
  });
  it("rejects overflowing and duplicate chunks", () => {
    const bytes = pcm();
    bytes.writeUInt32LE(0xffffffff, 40);
    expect(() => inspectConvertedWav(bytes, 10)).toThrow();
    const duplicate = Buffer.concat([pcm(), pcm().subarray(36)]);
    duplicate.writeUInt32LE(duplicate.length - 8, 4);
    expect(() => inspectConvertedWav(duplicate, 10)).toThrow();
  });
});

describe("file-backed long PCM verification", () => {
  async function sparsePcm(path: string, seconds: number) {
    const file = await open(path, "wx+", 0o600);
    const header = pcm().subarray(0, 44);
    header.writeUInt32LE(36 + seconds * 32_000, 4);
    header.writeUInt32LE(seconds * 32_000, 40);
    await file.write(header);
    await file.truncate(44 + seconds * 32_000);
    return file;
  }
  it("validates and hashes two hours with reads bounded to 64KiB and no readFile", async () => {
    const directory = await mkdtemp(join(tmpdir(), "wav-long-test-"));
    const file = await sparsePcm(join(directory, "two-hours.wav"), 7200);
    const reads = vi.spyOn(file, "read");
    const readFile = vi.spyOn(file, "readFile");
    try {
      expect(await inspectConvertedWavFile(file, 18000)).toEqual({
        durationSeconds: 7200,
        bytes: 230400044,
        sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
      });
      expect(readFile).not.toHaveBeenCalled();
      expect(
        reads.mock.calls.every((args) => Number((args as readonly unknown[])[2]) <= 65_536),
      ).toBe(true);
    } finally {
      await file.close();
      await rm(directory, { recursive: true, force: true });
    }
  });
  it("rejects more than five hours even with an unbounded requested duration", async () => {
    const directory = await mkdtemp(join(tmpdir(), "wav-long-test-"));
    const file = await sparsePcm(join(directory, "too-long.wav"), 18001);
    try {
      await expect(inspectConvertedWavFile(file, Number.MAX_SAFE_INTEGER)).rejects.toThrow(
        "invalid_converted_audio",
      );
    } finally {
      await file.close();
      await rm(directory, { recursive: true, force: true });
    }
  });
  it("rejects substitutions, forged checksums, wrong sizes, and cancellation", async () => {
    const directory = await mkdtemp(join(tmpdir(), "wav-long-test-"));
    const path = join(directory, "audio.wav");
    const file = await sparsePcm(path, 1);
    await file.close();
    try {
      await expect(
        inspectConvertedWavFile(path, 10, { expectedSha256: "0".repeat(64) }),
      ).rejects.toThrow("invalid_converted_audio");
      await expect(inspectConvertedWavFile(path, 10, { expectedBytes: 44 })).rejects.toThrow(
        "invalid_converted_audio",
      );
      const controller = new AbortController();
      controller.abort(new Error("test_cancelled"));
      await expect(
        inspectConvertedWavFile(path, 10, { signal: controller.signal }),
      ).rejects.toThrow("test_cancelled");
      await symlink(path, join(directory, "symlink.wav"));
      await expect(inspectConvertedWavFile(join(directory, "symlink.wav"), 10)).rejects.toThrow(
        "invalid_converted_audio",
      );
      await link(path, join(directory, "hardlink.wav"));
      await expect(inspectConvertedWavFile(path, 10)).rejects.toThrow("invalid_converted_audio");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
