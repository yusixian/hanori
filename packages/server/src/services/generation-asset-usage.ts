import type { Database } from "@cos-tool-bot/database";
import { generationAssetUses, promptAssets } from "@cos-tool-bot/database";
import { and, eq, sql } from "drizzle-orm";

type Transaction = Parameters<Parameters<Database["transaction"]>[0]>[0];

/** Called inside the transaction that claims generation success. */
export async function recordGenerationAssetUses(
  tx: Transaction,
  botId: string,
  generationId: string,
  assetIds: number[],
  completedAt: Date,
): Promise<void> {
  for (const assetId of [...new Set(assetIds)].sort((a, b) => a - b)) {
    const [inserted] = await tx
      .insert(generationAssetUses)
      .values({ botId, generationId, assetId, createdAt: completedAt })
      .onConflictDoNothing()
      .returning({ assetId: generationAssetUses.assetId });
    if (!inserted) continue;
    await tx
      .update(promptAssets)
      .set({
        useCount: sql`${promptAssets.useCount} + 1`,
        lastUsedAt: sql`greatest(${promptAssets.lastUsedAt}, ${completedAt.toISOString()}::timestamp)`,
      })
      .where(and(eq(promptAssets.botId, botId), eq(promptAssets.id, assetId)));
  }
}
