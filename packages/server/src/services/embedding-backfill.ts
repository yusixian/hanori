import { botMemories, conversationMessages, type Database } from "@cos-tool-bot/database";
import { DEFAULT_TIMEOUT_CONFIG } from "@cos-tool-bot/shared";
import { and, asc, eq, gt, inArray, isNull, lte, max, sql } from "drizzle-orm";
import type { EmbeddingService } from "./embedding-service.js";

export interface EmbeddingBackfillProgress {
  attempted: number;
  saved: number;
  failed: number;
  skipped: number;
}

/** Each selected row is attempted once; failed vectors remain eligible for a later manual run. */
export async function backfillMissingEmbeddings(
  db: Database,
  botId: string,
  kind: "memories" | "messages",
  embedder: Pick<EmbeddingService, "generateEmbeddings">,
  onProgress?: (progress: EmbeddingBackfillProgress) => void,
): Promise<EmbeddingBackfillProgress> {
  const table = kind === "memories" ? botMemories : conversationMessages;
  const scope = and(
    eq(table.botId, botId),
    kind === "messages" ? inArray(conversationMessages.role, ["user", "assistant"]) : undefined,
  );
  const progress = { attempted: 0, saved: 0, failed: 0, skipped: 0 };
  // Bound the scan despite concurrent inserts; this is not a transaction snapshot.
  const [boundary] = await db
    .select({ id: max(table.id) })
    .from(table)
    .where(and(scope, isNull(table.embedding)));
  if (boundary?.id == null) return progress;
  let cursor: number | undefined;
  while (true) {
    const rows = await db
      .select({ id: table.id, content: table.content })
      .from(table)
      .where(
        and(
          scope,
          isNull(table.embedding),
          cursor === undefined ? undefined : gt(table.id, cursor),
          lte(table.id, boundary.id),
        ),
      )
      .orderBy(asc(table.id))
      .limit(100);
    if (rows.length === 0) return progress;
    const embeddings = await embedder.generateEmbeddings(
      rows.map((row) => row.content),
      AbortSignal.timeout(DEFAULT_TIMEOUT_CONFIG.perStepMs),
    );
    const outcomes = await Promise.all(
      rows.map(async (row, index) => {
        const embedding = embeddings[index];
        if (embedding == null) return "failed" as const;
        const updated = await db
          .update(table)
          .set({
            embedding,
            // Vector-only writes must bypass the memory schema's automatic edit timestamp.
            ...(kind === "memories" ? { updatedAt: sql`${botMemories.updatedAt}` } : {}),
          })
          .where(
            and(
              eq(table.botId, botId),
              eq(table.id, row.id),
              eq(table.content, row.content),
              isNull(table.embedding),
            ),
          )
          .returning({ id: table.id });
        return updated.length ? ("saved" as const) : ("skipped" as const);
      }),
    );
    progress.attempted += rows.length;
    for (const outcome of outcomes) progress[outcome]++;
    cursor = rows.at(-1)!.id;
    onProgress?.({ ...progress });
  }
}
