export async function readBoundedImage(
  response: Response,
  maxBytes: number,
  limitMessage: string,
): Promise<Buffer> {
  if (!response.ok) throw new Error(`Image download failed: HTTP ${response.status}`);
  if (Number(response.headers.get("content-length")) > maxBytes) {
    await response.body?.cancel();
    throw new Error(limitMessage);
  }
  if (!response.body) throw new Error("Image response has no body");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) throw new Error(limitMessage);
      chunks.push(value);
    }
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
  return Buffer.concat(chunks, size);
}
