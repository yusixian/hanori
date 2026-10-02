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
    maxSeconds > 600 ||
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
