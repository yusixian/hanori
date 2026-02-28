/** Escape special characters for SQL LIKE/ILIKE patterns. */
export function escapeLike(s: string): string {
  return s.replace(/[%_\\]/g, "\\$&");
}

/** RRF (Reciprocal Rank Fusion) merge of two ranked result lists.
 *  Returns de-duplicated results sorted by combined RRF score. */
export function rrfMerge<T extends { id: number }>(
  keywordResults: T[],
  vectorResults: T[],
  keywordWeight: number,
  vectorWeight: number,
  k: number,
  limit: number,
): T[] {
  const scores = new Map<number, { score: number; item: T }>();

  for (let i = 0; i < keywordResults.length; i++) {
    const item = keywordResults[i]!;
    const score = keywordWeight / (k + i + 1);
    const existing = scores.get(item.id);
    if (existing) {
      existing.score += score;
    } else {
      scores.set(item.id, { score, item });
    }
  }

  for (let i = 0; i < vectorResults.length; i++) {
    const item = vectorResults[i]!;
    const score = vectorWeight / (k + i + 1);
    const existing = scores.get(item.id);
    if (existing) {
      existing.score += score;
    } else {
      scores.set(item.id, { score, item });
    }
  }

  return [...scores.values()]
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((e) => e.item);
}
