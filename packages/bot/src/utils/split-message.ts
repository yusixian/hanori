const TELEGRAM_MAX = 4096;

// Sentence-ending patterns (followed by space or end)
const SENTENCE_ENDS = /[.。！？!?;；]\s/g;

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

    // 1. Paragraph boundary (\n\n)
    let cutIdx = window.lastIndexOf("\n\n");
    // 2. Line boundary (\n)
    if (cutIdx <= 0) cutIdx = window.lastIndexOf("\n");
    // 3. Sentence boundary
    if (cutIdx <= 0) {
      let lastSentenceEnd = -1;
      SENTENCE_ENDS.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = SENTENCE_ENDS.exec(window)) !== null) {
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
