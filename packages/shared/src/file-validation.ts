import * as path from "node:path";

export const MAX_FILE_SIZE = 20 * 1024 * 1024; // 20MB
export const TEXT_EXTENSIONS = new Set([".md", ".txt", ".json", ".csv", ".xml", ".html", ".css"]);
export const IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg"]);
export const BINARY_EXTENSIONS = new Set([...IMAGE_EXTENSIONS, ".pdf"]);
export const ALLOWED_EXTENSIONS = new Set([...TEXT_EXTENSIONS, ...BINARY_EXTENSIONS]);

export const CONTENT_TYPE_MAP: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".pdf": "application/pdf",
  ".md": "text/markdown",
  ".txt": "text/plain",
  ".json": "application/json",
  ".csv": "text/csv",
  ".xml": "application/xml",
  ".html": "text/html",
  ".css": "text/css",
};

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

export function getDataDir(botId: string): string {
  if (!/^[\w-]+$/.test(botId)) throw new Error(`Invalid botId: ${botId}`);
  return path.join(process.cwd(), "data", botId);
}
