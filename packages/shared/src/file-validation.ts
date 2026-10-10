import * as path from "node:path";

import { ALLOWED_EXTENSIONS } from "./file-types.js";

/**
 * Resolve a relative file path against a data directory and validate:
 * - No null bytes (path traversal via null byte injection)
 * - Resolved path must be inside dataDir (prevents ../ traversal)
 * - File extension must be in ALLOWED_EXTENSIONS
 *
 * Returns the resolved absolute path, or null if validation fails.
 */
export function resolveAndValidate(dataDir: string, filePath: string): string | null {
  if (filePath.includes("\0")) return null;
  const resolved = path.resolve(dataDir, filePath);
  const normalizedDir = dataDir.endsWith(path.sep) ? dataDir.slice(0, -1) : dataDir;
  if (!resolved.startsWith(normalizedDir + path.sep)) return null;
  const ext = path.extname(resolved).toLowerCase();
  if (!ALLOWED_EXTENSIONS.has(ext)) return null;
  return resolved;
}

/**
 * Validate a subdirectory path relative to a data directory.
 * Empty string is valid (means root). Returns resolved absolute path or null.
 */
export function resolveAndValidateDir(dataDir: string, dirPath: string): string | null {
  if (dirPath.includes("\0")) return null;
  if (dirPath === "") return dataDir;
  const resolved = path.resolve(dataDir, dirPath);
  const normalizedDir = dataDir.endsWith(path.sep) ? dataDir.slice(0, -1) : dataDir;
  if (!resolved.startsWith(normalizedDir + path.sep)) return null;
  return resolved;
}

export function getDataDir(botId: string): string {
  if (!/^[\w-]+$/.test(botId)) throw new Error(`Invalid botId: ${botId}`);
  return path.join(process.cwd(), "data", botId);
}
