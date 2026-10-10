import type { Database } from "@cos-tool-bot/database";
import { botMemories } from "@cos-tool-bot/database";
import { and, eq, getTableColumns, inArray, sql } from "drizzle-orm";

export const MEMORY_DUPLICATE_BATCH_MAX = 50;

export interface MemoryDuplicateCandidate {
  candidateId: number;
  survivorId: number;
  expectedCandidateUpdatedAt: string;
  expectedSurvivorUpdatedAt: string;
}

interface RankedDuplicateRow extends Record<string, unknown> {
  id: number;
  survivor_id: number;
  candidate_updated_at: string;
  survivor_updated_at: string;
  content: string;
  telegram_id: number | null;
  scope_chat_id: number | null;
  kind: string | null;
  category: string | null;
}

function version(row: { updatedAt: Date | null; createdAt: Date }): string {
  return (row.updatedAt ?? row.createdAt).toISOString();
}

function sameDate(first: Date | null, second: Date | null): boolean {
  return (first?.getTime() ?? null) === (second?.getTime() ?? null);
}

type LockedMemory = typeof botMemories.$inferSelect & { createdAtMicros: bigint };

function preferredSurvivor(candidate: LockedMemory, survivor: LockedMemory): boolean {
  if ((candidate.embedding !== null) !== (survivor.embedding !== null)) {
    return survivor.embedding !== null;
  }
  return (
    candidate.createdAtMicros < survivor.createdAtMicros ||
    (candidate.createdAtMicros === survivor.createdAtMicros && candidate.id < survivor.id)
  );
}

function sameIdentity(
  first: typeof botMemories.$inferSelect,
  second: typeof botMemories.$inferSelect,
): boolean {
  return (
    first.botId === second.botId &&
    first.telegramId === second.telegramId &&
    first.scopeChatId === second.scopeChatId &&
    first.content === second.content &&
    first.kind === second.kind &&
    first.category === second.category &&
    sameDate(first.expiresAt, second.expiresAt) &&
    sameDate(first.factValidAt, second.factValidAt)
  );
}

export class MemoryLegacyCleanup {
  constructor(private readonly db: Database) {}

  async preview(botId: string) {
    // Partition only exact values. Unknown legacy ownership stays unknown.
    const rows = await this.db.execute<RankedDuplicateRow>(sql`
      with ranked as (
        select id, content, telegram_id, scope_chat_id, kind, category,
          to_char(coalesce(updated_at, created_at), 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as candidate_updated_at,
          first_value(id) over identity_order as survivor_id,
          first_value(to_char(coalesce(updated_at, created_at), 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')) over identity_order as survivor_updated_at,
          row_number() over identity_order as duplicate_rank
        from bot_memories
        where bot_id = ${botId} and is_active = true
        window identity_order as (
          partition by telegram_id, scope_chat_id, content, kind, category, expires_at, fact_valid_at
          order by (embedding is not null) desc, created_at desc, id desc
        )
      )
      select id, survivor_id, candidate_updated_at, survivor_updated_at,
        content, telegram_id, scope_chat_id, kind, category
      from ranked where duplicate_rank > 1
      order by id desc
      limit ${MEMORY_DUPLICATE_BATCH_MAX + 1}
    `);
    return {
      data: rows.slice(0, MEMORY_DUPLICATE_BATCH_MAX).map((row) => ({
        candidateId: row.id,
        survivorId: row.survivor_id,
        expectedCandidateUpdatedAt: row.candidate_updated_at,
        expectedSurvivorUpdatedAt: row.survivor_updated_at,
        content: row.content,
        telegramId: row.telegram_id === null ? null : Number(row.telegram_id),
        scopeChatId: row.scope_chat_id === null ? null : Number(row.scope_chat_id),
        kind: row.kind,
        category: row.category,
      })),
      hasMore: rows.length > MEMORY_DUPLICATE_BATCH_MAX,
      batchMax: MEMORY_DUPLICATE_BATCH_MAX,
    };
  }

  async retireBatch(botId: string, candidates: MemoryDuplicateCandidate[]) {
    if (
      candidates.length < 1 ||
      candidates.length > MEMORY_DUPLICATE_BATCH_MAX ||
      candidates.some(
        ({ candidateId, survivorId }) =>
          !Number.isSafeInteger(candidateId) ||
          !Number.isSafeInteger(survivorId) ||
          candidateId < 1 ||
          survivorId < 1 ||
          candidateId === survivorId,
      ) ||
      new Set(candidates.map(({ candidateId }) => candidateId)).size !== candidates.length ||
      candidates.some(({ survivorId }) =>
        candidates.some(({ candidateId }) => candidateId === survivorId),
      )
    ) {
      throw new RangeError("Invalid memory duplicate cleanup batch");
    }
    return this.db.transaction(async (tx) => {
      const ids = [
        ...new Set(candidates.flatMap(({ candidateId, survivorId }) => [candidateId, survivorId])),
      ].sort((a, b) => a - b);
      const rows = await tx
        .select({
          ...getTableColumns(botMemories),
          // Date loses microseconds; use the same full precision as the preview ordering.
          createdAtMicros:
            sql`(extract(epoch from ${botMemories.createdAt}) * 1000000)::bigint`.mapWith(BigInt),
        })
        .from(botMemories)
        .where(and(eq(botMemories.botId, botId), inArray(botMemories.id, ids)))
        .orderBy(botMemories.id)
        .for("update");
      const byId = new Map(rows.map((row) => [row.id, row]));

      for (const candidate of candidates) {
        const older = byId.get(candidate.candidateId);
        const newer = byId.get(candidate.survivorId);
        if (
          older?.botId !== botId ||
          newer?.botId !== botId ||
          !older.isActive ||
          !newer?.isActive ||
          !sameIdentity(older, newer) ||
          version(older) !== candidate.expectedCandidateUpdatedAt ||
          version(newer) !== candidate.expectedSurvivorUpdatedAt ||
          !preferredSurvivor(older, newer)
        ) {
          return null;
        }
      }

      for (const { candidateId, survivorId } of candidates) {
        const updated = await tx
          .update(botMemories)
          .set({ isActive: false, supersededById: survivorId })
          .where(
            and(
              eq(botMemories.botId, botId),
              eq(botMemories.id, candidateId),
              eq(botMemories.isActive, true),
            ),
          )
          .returning({ id: botMemories.id });
        if (updated.length !== 1) throw new Error("Memory duplicate changed during cleanup");
      }
      return { retiredCount: candidates.length };
    });
  }
}
