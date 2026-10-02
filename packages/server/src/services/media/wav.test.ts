import { describe, expect, it } from "vitest";
import { inspectConvertedWav } from "./wav.js";

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
