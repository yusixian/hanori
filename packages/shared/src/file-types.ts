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
