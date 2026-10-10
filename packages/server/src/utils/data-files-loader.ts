import { DEFAULT_INJECTABLE_FILES, DEFAULT_MAX_INJECTION_SIZE } from "@cos-tool-bot/shared";
import type { DataFilesConfig } from "@cos-tool-bot/bot";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { getDataDir } from "./file-validation.js";

export interface DataFilesLoaderOptions {
  injectableFiles?: string[];
  maxTotalSize?: number;
  cacheTtlMs?: number;
}

const PRIORITY_FILES = ["IDENTITY.md", "SOUL.md"];
const DEFAULT_CACHE_TTL_MS = 30_000; // 30s

/**
 * Create a DataFilesConfig for a given bot.
 * Shared by bot-pool (runtime) and the prompt-preview API endpoint.
 */
export async function createDataFilesLoader(
  botId: string,
  options?: DataFilesLoaderOptions,
): Promise<DataFilesConfig> {
  const dataDir = getDataDir(botId);
  await fs.mkdir(dataDir, { recursive: true });

  const injectableSet = new Set(options?.injectableFiles ?? DEFAULT_INJECTABLE_FILES);
  const maxTotalSize = options?.maxTotalSize ?? DEFAULT_MAX_INJECTION_SIZE;
  const cacheTtlMs = options?.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS;

  let cachedFiles: Array<{ name: string; content: string }> | null = null;
  let cacheTime = 0;

  return {
    dataDir,
    injectableFiles: injectableSet as ReadonlySet<string>,
    loadFiles: async () => {
      const now = Date.now();
      if (cachedFiles && now - cacheTime < cacheTtlMs) return cachedFiles;
      try {
        const entries = await fs.readdir(dataDir);
        const mdFiles = entries.filter((f) => f.endsWith(".md") && injectableSet.has(f));
        mdFiles.sort((a, b) => {
          const ai = PRIORITY_FILES.indexOf(a);
          const bi = PRIORITY_FILES.indexOf(b);
          if (ai >= 0 && bi >= 0) return ai - bi;
          if (ai >= 0) return -1;
          if (bi >= 0) return 1;
          return a.localeCompare(b);
        });
        const results: Array<{ name: string; content: string }> = [];
        let totalSize = 0;
        let hadReadFailure = false;
        for (const name of mdFiles) {
          let content: string;
          try {
            content = await fs.readFile(path.join(dataDir, name), "utf-8");
          } catch {
            hadReadFailure = true;
            continue;
          }
          if (!content.trim()) continue;
          const size = Buffer.byteLength(content, "utf-8");
          if (totalSize + size > maxTotalSize) break;
          totalSize += size;
          results.push({ name, content });
        }
        // Do not cache a partial read: a repaired file should be retried on the next load.
        if (!hadReadFailure) {
          cachedFiles = results;
          cacheTime = now;
        }
        return results;
      } catch {
        return [];
      }
    },
  };
}
