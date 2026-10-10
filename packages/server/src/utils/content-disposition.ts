/** Headers require an ASCII fallback; filename* preserves the original Unicode name. */
export function attachmentDisposition(filename: string): string {
  const fallbackName = filename.replace(/[^\u0020-\u007e]|["\\]/g, "_");
  const encodedName = encodeURIComponent(filename).replace(
    /['()*]/g,
    (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`,
  );
  return `attachment; filename="${fallbackName}"; filename*=UTF-8''${encodedName}`;
}
