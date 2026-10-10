import type { Database } from "@cos-tool-bot/database";
import type { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MEMORY_DUPLICATE_BATCH_MAX, MemoryLegacyCleanup } from "./memory-legacy-cleanup.js";

const botId = "11111111-1111-4111-8111-111111111111";
const now = new Date("2026-09-24T12:00:00.000Z");
const olderTime = new Date("2026-09-23T12:00:00.000Z");

function memory(id: number, overrides: Record<string, unknown> = {}) {
  const row = {
    id,
    botId,
    telegramId: 7,
    scopeChatId: null,
    content: "The user likes tea",
    kind: "preference",
    category: null,
    expiresAt: null,
    factValidAt: null,
    embedding: null,
    createdAt: id === 1 ? olderTime : now,
    updatedAt: id === 1 ? olderTime : now,
    isActive: true,
    ...overrides,
  };
  return { ...row, createdAtMicros: BigInt(row.createdAt.getTime()) * 1000n };
}

function candidate() {
  return {
    candidateId: 1,
    survivorId: 2,
    expectedCandidateUpdatedAt: olderTime.toISOString(),
    expectedSurvivorUpdatedAt: now.toISOString(),
  };
}

describe("MemoryLegacyCleanup", () => {
  const execute = vi.fn();
  const returning = vi.fn();
  const lockedRows = vi.fn();
  const update = vi.fn();
  const tx = {
    select: () => ({
      from: () => ({ where: () => ({ orderBy: () => ({ for: lockedRows }) }) }),
    }),
    update: () => ({
      set: (values: unknown) => {
        update(values);
        return { where: () => ({ returning }) };
      },
    }),
  };
  const db = {
    execute,
    transaction: (callback: (transaction: typeof tx) => unknown) => callback(tx),
  } as unknown as Database;
  const service = new MemoryLegacyCleanup(db);

  beforeEach(() => {
    vi.clearAllMocks();
    lockedRows.mockResolvedValue([memory(1), memory(2)]);
    returning.mockResolvedValue([{ id: 1 }]);
  });

  it("returns a bounded read-only preview with explicit candidate and survivor versions", async () => {
    execute.mockResolvedValue([
      {
        id: 1,
        survivor_id: 2,
        candidate_updated_at: olderTime.toISOString(),
        survivor_updated_at: now.toISOString(),
        content: "The user likes tea",
        telegram_id: 7,
        scope_chat_id: null,
        kind: "preference",
        category: null,
      },
    ]);
    expect(await service.preview(botId)).toEqual({
      data: [
        {
          ...candidate(),
          content: "The user likes tea",
          telegramId: 7,
          scopeChatId: null,
          kind: "preference",
          category: null,
        },
      ],
      hasMore: false,
      batchMax: MEMORY_DUPLICATE_BATCH_MAX,
    });
    const query = new PgDialect().sqlToQuery(execute.mock.calls[0]![0] as SQL);
    expect(query.sql).toContain("where bot_id = $1 and is_active = true");
    expect(query.sql).toContain(
      "partition by telegram_id, scope_chat_id, content, kind, category, expires_at, fact_valid_at",
    );
    expect(query.sql).toContain("to_char(coalesce(updated_at, created_at)");
    expect(query.sql).toContain("order by (embedding is not null) desc, created_at desc, id desc");
    expect(query.params).toEqual([botId, MEMORY_DUPLICATE_BATCH_MAX + 1]);
    expect(update).not.toHaveBeenCalled();
  });

  it("retires only a locked exact duplicate and records its survivor", async () => {
    expect(await service.retireBatch(botId, [candidate()])).toEqual({ retiredCount: 1 });
    expect(update).toHaveBeenCalledWith({ isActive: false, supersededById: 2 });
  });

  it.each([
    ["different user", { telegramId: 8 }],
    ["different chat", { scopeChatId: -100 }],
    ["different text", { content: "The user likes coffee" }],
    ["different kind", { kind: "fact" }],
    ["different category", { category: "food" }],
    ["different expiration", { expiresAt: new Date("2026-09-25T12:00:00.000Z") }],
    ["different fact validity", { factValidAt: now }],
    ["different bot", { botId: "other" }],
    ["inactive survivor", { isActive: false }],
  ])("rejects %s during the locked recheck", async (_label, overrides) => {
    lockedRows.mockResolvedValue([memory(1), memory(2, overrides)]);
    expect(await service.retireBatch(botId, [candidate()])).toBeNull();
    expect(update).not.toHaveBeenCalled();
  });

  it("rejects a stale version or a survivor older than the candidate", async () => {
    expect(
      await service.retireBatch(botId, [
        { ...candidate(), expectedSurvivorUpdatedAt: olderTime.toISOString() },
      ]),
    ).toBeNull();
    lockedRows.mockResolvedValue([
      memory(1, { createdAt: now }),
      memory(2, { createdAt: olderTime }),
    ]);
    expect(await service.retireBatch(botId, [candidate()])).toBeNull();
    expect(update).not.toHaveBeenCalled();
  });

  it("keeps an embedded memory even when it is older", async () => {
    lockedRows.mockResolvedValue([memory(1, { embedding: [0.1] }), memory(2)]);
    expect(await service.retireBatch(botId, [candidate()])).toBeNull();
    expect(update).not.toHaveBeenCalled();

    lockedRows.mockResolvedValue([memory(1), memory(2, { embedding: [0.1] })]);
    expect(await service.retireBatch(botId, [candidate()])).toEqual({ retiredCount: 1 });
  });

  it("rejects oversized, repeated, and chained confirmation lists", async () => {
    await expect(service.retireBatch(botId, [])).rejects.toThrow(RangeError);
    await expect(
      service.retireBatch(botId, Array(MEMORY_DUPLICATE_BATCH_MAX + 1).fill(candidate())),
    ).rejects.toThrow(RangeError);
    await expect(service.retireBatch(botId, [candidate(), candidate()])).rejects.toThrow(
      RangeError,
    );
    await expect(
      service.retireBatch(botId, [candidate(), { ...candidate(), candidateId: 2, survivorId: 3 }]),
    ).rejects.toThrow(RangeError);
    expect(lockedRows).not.toHaveBeenCalled();
  });
});
