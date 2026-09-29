import { mkdir, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { IMAGE_EXTENSIONS, getDataDir } from "@cos-tool-bot/shared";
import type { Logger } from "pino";

const GENERATION_IMAGE_DOWNLOAD_TIMEOUT_MS = 30_000;

function guessExtension(url: string): string {
  try {
    const pathname = new URL(url).pathname;
    const ext = path.extname(pathname).toLowerCase();
    if (IMAGE_EXTENSIONS.has(ext)) return ext;
  } catch {
    // ignore
  }
  return ".png";
}

export async function downloadGenerationImages(
  botId: string,
  taskId: string,
  urls: string[],
  logger: Logger,
): Promise<string[]> {
  const dir = path.join(getDataDir(botId), "generations");
  await mkdir(dir, { recursive: true });
  const results = await Promise.all(
    urls.map(async (url, i) => {
      const ext = guessExtension(url);
      const filename = `${taskId}_${i}${ext}`;
      try {
        const res = await fetch(url, {
          signal: AbortSignal.timeout(GENERATION_IMAGE_DOWNLOAD_TIMEOUT_MS),
        });
        if (!res.ok) {
          logger.warn({ taskId, index: i, status: res.status }, "PixAI image download failed");
          return null;
        }
        const buffer = Buffer.from(await res.arrayBuffer());
        await writeFile(path.join(dir, filename), buffer);
        return filename;
      } catch (err) {
        logger.warn(err, `PixAI image download error: task=${taskId} index=${i}`);
        return null;
      }
    }),
  );
  return results.filter((f): f is string => f != null);
}

export async function cleanupGenerationImages(
  botId: string,
  localFiles: string[],
  logger: Logger,
): Promise<void> {
  const dir = path.join(getDataDir(botId), "generations");
  await Promise.all(
    localFiles.map(async (filename) => {
      try {
        await unlink(path.join(dir, filename));
      } catch (err) {
        logger.warn(err, `PixAI image cleanup error: file=${filename}`);
      }
    }),
  );
}
