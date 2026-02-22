const TELEGRAM_MAX = 4096;

/**
 * Split a long message into chunks at natural boundaries.
 *
 * @param text     - The full message text
 * @param threshold - Max chars per chunk (0 = disabled)
 * @returns Array of non-empty text chunks
 */
export function splitMessage(text: string, threshold: number): string[] {
  if (threshold <= 0 || text.length <= threshold) return [text];

  const chunks: string[] = [];
  let remaining = text;

  while (remaining.length > threshold) {
    const window = remaining.slice(0, threshold);

    let cutIdx = -1;

    // 1. Paragraph boundary (\n\n) — cut after the separator
    const paraIdx = window.lastIndexOf("\n\n");
    if (paraIdx > 0) cutIdx = paraIdx + 2;

    // 2. Line boundary (\n) — cut after the newline
    if (cutIdx <= 0) {
      const lineIdx = window.lastIndexOf("\n");
      if (lineIdx > 0) cutIdx = lineIdx + 1;
    }

    // 3. Sentence boundary (punctuation followed by whitespace)
    if (cutIdx <= 0) {
      let lastSentenceEnd = -1;
      for (const m of window.matchAll(/[.。！？!?;；]\s/g)) {
        lastSentenceEnd = m.index + m[0].length;
      }
      if (lastSentenceEnd > 0) cutIdx = lastSentenceEnd;
    }

    // 4. Hard cut
    if (cutIdx <= 0) cutIdx = threshold;

    const chunk = remaining.slice(0, cutIdx).trim();
    if (chunk) chunks.push(chunk);
    remaining = remaining.slice(cutIdx).trim();
  }

  if (remaining) chunks.push(remaining);

  // Safety: enforce Telegram's 4096 limit per chunk
  const safe: string[] = [];
  for (const chunk of chunks) {
    if (chunk.length <= TELEGRAM_MAX) {
      safe.push(chunk);
    } else {
      for (let i = 0; i < chunk.length; i += TELEGRAM_MAX) {
        const part = chunk.slice(i, i + TELEGRAM_MAX).trim();
        if (part) safe.push(part);
      }
    }
  }

  return safe;
}
