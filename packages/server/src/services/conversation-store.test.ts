import {
  conversationCompactionState,
  conversationMessages,
  conversationSummaries,
  type Database,
} from "@cos-tool-bot/database";
import type { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildConversationHistoryBoundary,
  COMPACTION_MAX_BATCH_JSON_CHARS,
  COMPACTION_MAX_BATCH_MESSAGES,
  CONVERSATION_SUMMARY_RECENT_VERSIONS,
  ConversationStore,
  retainedConversationSummaryIds,
  selectHistoryWithinTokenBudget,
} from "./conversation-store.js";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("buildConversationHistoryBoundary", () => {
  it("bounds Telegram turns by message ID while retaining an ID fallback", () => {
    const query = new PgDialect().sqlToQuery(buildConversationHistoryBoundary(102, 12) as SQL);

    expect(query.sql).toContain("split_part");
    expect(query.sql).toContain("source_key");
    expect(query.sql).toContain('"id" <');
    expect(query.params).toEqual([12, 102]);
  });
});

describe("ConversationStore.getHistory", () => {
  it.each([undefined, 12_000])(
    "scopes topic history before applying budget %s and excludes mixed summaries",
    async (tokenBudget) => {
      for (const threadId of [20, null]) {
        const conditions: ReturnType<PgDialect["sqlToQuery"]>[] = [];
        const tables: unknown[] = [];
        const db = {
          select: () => {
            const query = {
              from: (table: unknown) => {
                tables.push(table);
                return query;
              },
              where: (condition: SQL) => {
                conditions.push(new PgDialect().sqlToQuery(condition));
                return query;
              },
              orderBy: () => query,
              limit: async () => [],
            };
            return query;
          },
        } as unknown as Database;
        const result = await new ConversationStore(db).getHistory("bot", -100, 20, tokenBudget, {
          threadId,
        });
        expect(result.summary).toBeNull();
        expect(tables).toEqual([conversationMessages]);
        expect(conditions[0]!.sql).toContain("->>'threadId'");
        if (threadId === null) {
          expect(conditions[0]!.sql).toContain("::jsonb ? 'threadId'");
          expect(conditions[0]!.sql).toContain("->>'threadId' IS NULL");
        } else expect(conditions[0]!.params).toContain("20");
      }
    },
  );

  it("keeps queued Telegram turns in conversation order", async () => {
    const rows = [
      {
        id: 101,
        role: "user",
        content: "A user",
        userName: "A",
        createdAt: new Date("2026-07-29T00:00:01.000Z"),
        turnOrderId: 101,
        meta: {
          forwardOrigin: { type: "hidden_user", name: "Forwarded Alice" },
        },
      },
      {
        id: 102,
        role: "user",
        content: "B user",
        userName: "B",
        createdAt: new Date("2026-07-29T00:00:02.000Z"),
        turnOrderId: 102,
        meta: null,
      },
      {
        id: 104,
        role: "assistant",
        content: "A assistant",
        userName: null,
        createdAt: new Date("2026-07-29T00:00:04.000Z"),
        turnOrderId: 101,
        meta: null,
      },
      {
        id: 105,
        role: "assistant",
        content: "B assistant",
        userName: null,
        createdAt: new Date("2026-07-29T00:00:05.000Z"),
        turnOrderId: 102,
        meta: null,
      },
    ];
    const dialect = new PgDialect();
    let selectedTable: unknown;
    let orderSql = "";
    const db = {
      select: () => {
        const query = {
          from: (table: unknown) => {
            selectedTable = table;
            return query;
          },
          innerJoin: () => query,
          where: () => query,
          orderBy: (...expressions: SQL[]) => {
            orderSql = expressions
              .map((expression) => dialect.sqlToQuery(expression).sql)
              .join(" ");
            return query;
          },
          limit: async (limit: number) => {
            if (selectedTable === conversationCompactionState) return [];
            const usesTurnOrder = orderSql.includes("turnOrderId");
            return [...rows]
              .sort((left, right) => {
                const leftOrder = usesTurnOrder ? left.turnOrderId : left.id;
                const rightOrder = usesTurnOrder ? right.turnOrderId : right.id;
                return rightOrder - leftOrder || right.id - left.id;
              })
              .slice(0, limit);
          },
        };
        return query;
      },
    } as unknown as Database;
    const store = new ConversationStore(db);

    const history = await store.getHistory(baseParams.botId, baseParams.chatId, 20, undefined, {
      beforeId: 103,
      beforeTelegramMessageId: 13,
    });

    expect(history.messages.map((message) => message.content)).toEqual([
      "A user",
      "A assistant",
      "B user",
      "B assistant",
    ]);
    expect(history.messages[0]?.forwardOrigin).toEqual({
      type: "hidden_user",
      name: "Forwarded Alice",
    });
    expect(history.messages[1]).not.toHaveProperty("forwardOrigin");
    expect(orderSql).toContain("turnOrderId");
  });

  it("keeps both sides of a turn when token-budget history crosses a page boundary", async () => {
    const rows = Array.from({ length: 101 }, (_, index) => {
      const userId = index + 101;
      return [
        {
          id: userId,
          role: "user",
          content: `user ${index + 1}`,
          userName: `User ${index + 1}`,
          createdAt: new Date(1_700_000_000_000 + index),
          historyOrderId: userId,
          meta: index === 100 ? { forwardOrigin: { type: "channel", name: "Daily News" } } : null,
        },
        {
          id: userId + 101,
          role: "assistant",
          content: `assistant ${index + 1}`,
          userName: null,
          createdAt: new Date(1_700_000_100_000 + index),
          historyOrderId: userId,
          meta: null,
        },
      ];
    }).flat();
    const newestFirst = [...rows].sort(
      (left, right) => right.historyOrderId - left.historyOrderId || right.id - left.id,
    );
    const dialect = new PgDialect();
    let selectedTable: unknown;
    let historyReadCount = 0;
    let whereSql = "";
    const historyWhereSql: string[] = [];
    const db = {
      select: () => {
        const query = {
          from: (table: unknown) => {
            selectedTable = table;
            return query;
          },
          innerJoin: () => query,
          where: (expression: SQL) => {
            whereSql = dialect.sqlToQuery(expression).sql;
            return query;
          },
          orderBy: () => query,
          limit: async () => {
            if (selectedTable === conversationCompactionState) return [];
            historyReadCount++;
            historyWhereSql.push(whereSql);
            if (historyReadCount === 1) return newestFirst.slice(0, 200);
            if (historyReadCount === 2 && whereSql.includes("turnOrderId")) {
              return newestFirst.slice(200);
            }
            return [];
          },
        };
        return query;
      },
    } as unknown as Database;
    const store = new ConversationStore(db);

    const history = await store.getHistory(baseParams.botId, baseParams.chatId, 20, 12_000, {
      beforeId: 500,
      beforeTelegramMessageId: 500,
    });

    expect(history.messages).toHaveLength(202);
    expect(history.messages.slice(0, 4).map((message) => message.content)).toEqual([
      "user 1",
      "assistant 1",
      "user 2",
      "assistant 2",
    ]);
    expect(
      history.messages.find((message) => message.content === "user 101")?.forwardOrigin,
    ).toEqual({ type: "channel", name: "Daily News" });
    expect(historyWhereSql[1]).toContain("turnOrderId");
  });

  it.each([undefined, 12_000])(
    "projects the Telegram message id out of meta with a token budget of %s",
    async (tokenBudget) => {
      const rows = [
        {
          id: 201,
          role: "user",
          content: "带 id 的消息",
          userName: "Casey",
          createdAt: new Date("2026-07-29T00:00:01.000Z"),
          turnOrderId: 201,
          meta: {
            tgMessageId: 4820,
            source: "cosinside",
            initiatorTelegramId: 42,
            initiatorName: "Alice",
          },
        },
        {
          id: 202,
          role: "user",
          content: "没有 id 的消息",
          userName: "Bob",
          createdAt: new Date("2026-07-29T00:00:02.000Z"),
          turnOrderId: 202,
          meta: { tgMessageId: "4821" },
        },
      ];
      let selectedTable: unknown;
      const db = {
        select: () => {
          const query = {
            from: (table: unknown) => {
              selectedTable = table;
              return query;
            },
            innerJoin: () => query,
            where: () => query,
            orderBy: () => query,
            limit: async () =>
              selectedTable === conversationCompactionState ? [] : [...rows].reverse(),
          };
          return query;
        },
      } as unknown as Database;

      const history = await new ConversationStore(db).getHistory(
        baseParams.botId,
        baseParams.chatId,
        20,
        tokenBudget,
      );

      expect(history.messages.map((message) => message.tgMessageId)).toEqual([4820, undefined]);
      expect(history.messages[0]?.relayOrigin).toEqual({
        source: "cosinside",
        initiatorTelegramId: 42,
        initiatorName: "Alice",
      });
      expect(history.messages[1]).not.toHaveProperty("relayOrigin");
    },
  );
});

describe("selectHistoryWithinTokenBudget", () => {
  const rows = Array.from({ length: 21 }, (_, index) => ({
    id: index + 1,
    role: "user",
    content: `short message ${index + 1}`,
    userName: "User",
    createdAt: new Date(1_700_000_000_000 + index),
  }));

  it("keeps every raw message when more than 20 messages still fit the token budget", () => {
    const selected = selectHistoryWithinTokenBudget(rows, undefined, 12_000);
    expect(selected.summary).toBeNull();
    expect(selected.messages).toHaveLength(21);
    expect(selected.trace.completeRawHistory).toBe(true);
    expect(selected.trace.earliestMessageId).toBe(1);
    expect(selected.trace.latestMessageId).toBe(21);
  });

  it("charges rendered forwarding attribution against the history token budget", () => {
    const plain = selectHistoryWithinTokenBudget(rows.slice(0, 1), undefined, 12_000);
    const forwarded = selectHistoryWithinTokenBudget(
      [
        {
          ...rows[0]!,
          forwardOrigin: {
            type: "channel",
            name: "Daily News With A Visible Source Name",
          },
        },
      ],
      undefined,
      12_000,
    );

    expect(forwarded.trace.usedTokens).toBeGreaterThan(plain.trace.usedTokens);
  });

  it("budgets relay attribution and preserves it when the body is truncated", () => {
    const plain = selectHistoryWithinTokenBudget(rows.slice(0, 1), undefined, 12_000);
    const relayOrigin = {
      source: "cosinside" as const,
      initiatorTelegramId: 42,
      initiatorName: "Alice",
    };
    const attributed = selectHistoryWithinTokenBudget(
      [{ ...rows[0]!, role: "context", relayOrigin }],
      undefined,
      12_000,
    );
    expect(attributed.trace.usedTokens).toBeGreaterThan(plain.trace.usedTokens);
    const truncated = selectHistoryWithinTokenBudget(
      [{ ...rows[0]!, role: "context", relayOrigin, content: "long body ".repeat(500) }],
      undefined,
      100,
    );
    expect(truncated.messages[0]?.relayOrigin).toEqual(relayOrigin);
    expect(truncated.messages[0]!.content.length).toBeLessThan(5000);
  });

  it("does not expose a full quote source when its visible history body is truncated", () => {
    const quoteSource = {
      version: 1 as const,
      messageId: 10,
      threadId: null,
      capturedAt: 100,
      text: "long body ".repeat(500),
      entities: [],
      author: { key: "user:42", name: "Alice" },
      privacyUserIds: [42],
    };
    const result = selectHistoryWithinTokenBudget(
      [{ ...rows[0]!, content: quoteSource.text, quoteSource }],
      undefined,
      100,
    );
    expect(result.messages).toHaveLength(1);
    expect(result.messages[0]?.content.length).toBeLessThan(quoteSource.text.length);
    expect(result.messages[0]?.quoteSource).toBeUndefined();
  });

  it("marks a compacted summary as degraded when the raw tail is also truncated", () => {
    const largeRows = rows.map((row) => ({ ...row, content: row.content.repeat(100) }));
    const selected = selectHistoryWithinTokenBudget(
      largeRows,
      { cursorId: 10, content: "Earlier history summary ".repeat(100) },
      300,
    );

    expect(selected.trace.completeRawHistory).toBe(false);
    expect(selected.trace.usedSummary).toBe(true);
    expect(selected.trace.degraded).toBe(true);
    expect(selected.messages.at(-1)?.id).toBe(21);
    expect(selected.messages.every((message) => message.id > 10)).toBe(true);
    expect(selected.trace.usedTokens).toBeLessThanOrEqual(300);
  });

  it("uses a summary without degradation when it covers all omitted rows", () => {
    const largeRows = rows.map((row) => ({ ...row, content: row.content.repeat(100) }));
    const selected = selectHistoryWithinTokenBudget(
      largeRows,
      { cursorId: 20, content: "Earlier history summary ".repeat(100) },
      300,
    );

    expect(selected.trace.completeRawHistory).toBe(false);
    expect(selected.trace.usedSummary).toBe(true);
    expect(selected.trace.degraded).toBe(false);
    expect(selected.messages.map((message) => message.id)).toEqual([21]);
  });

  it("does not let a partial scan hide the gap before the newest tail", () => {
    const newestRows = Array.from({ length: 200 }, (_, index) => ({
      id: 801 + index,
      role: "user",
      content: `message ${801 + index} ${"long ".repeat(80)}`,
      userName: "User",
      createdAt: new Date(1_700_000_000_000 + index),
    }));
    const selected = selectHistoryWithinTokenBudget(
      newestRows,
      { cursorId: 200, content: "Summary through message 200" },
      500,
      { scannedAllHistory: false, scannedThroughActiveCursor: false },
    );

    expect(selected.trace.usedSummary).toBe(true);
    expect(selected.trace.degraded).toBe(true);
  });

  it("keeps using the summary after raw history has been pruned even if retained rows fit", () => {
    const selected = selectHistoryWithinTokenBudget(
      rows.slice(10),
      {
        cursorId: 10,
        content: "Summary through message 10",
        rawHistoryIntact: false,
      },
      12_000,
    );

    expect(selected.summary).toContain("Summary through message 10");
    expect(selected.trace.completeRawHistory).toBe(false);
    expect(selected.trace.usedSummary).toBe(true);
    expect(selected.trace.degraded).toBe(true);
    expect(selected.trace.compressionRecommended).toBe(false);
  });
});

interface SummaryRow {
  id: number;
  summarizedUpToId: number;
  [key: string]: unknown;
}

function createCommitDb(options?: {
  summaries?: SummaryRow[];
  activeSummaryId?: number | null;
  currentSelectionMissing?: boolean;
  loseUpdateRace?: boolean;
  sourceMessageIds?: number[];
}) {
  const state = {
    summaries: options?.summaries?.map((row) => ({ ...row })) ?? [],
    activeSummaryId: options?.activeSummaryId ?? null,
    sourceMessageIds:
      options?.sourceMessageIds ?? Array.from({ length: 10 }, (_, index) => index + 1),
  };

  function createTransaction(draft: typeof state) {
    let summarySelectionCount = 0;
    return {
      select: () => {
        let selectedTable: unknown;
        const query = {
          from: (table: unknown) => {
            selectedTable = table;
            return query;
          },
          innerJoin: () => query,
          where: () => query,
          orderBy: () => query,
          for: async () =>
            selectedTable === conversationMessages
              ? draft.sourceMessageIds.map((id) => ({ id }))
              : [],
          limit: async (limit: number) => {
            if (selectedTable === conversationSummaries) {
              summarySelectionCount++;
              const recent = [...draft.summaries].sort((a, b) => b.id - a.id);
              if (summarySelectionCount === 1)
                return recent.slice(0, limit).map(({ id }) => ({ id }));
              const retained = retainedConversationSummaryIds(
                recent.slice(0, CONVERSATION_SUMMARY_RECENT_VERSIONS + 1).map((row) => row.id),
                draft.activeSummaryId,
              );
              return [...draft.summaries]
                .filter((row) => !retained.includes(row.id))
                .sort((a, b) => a.id - b.id)
                .slice(0, limit)
                .map(({ id }) => ({ id }));
            }
            if (options?.currentSelectionMissing || draft.activeSummaryId === null) return [];
            const summary = draft.summaries.find((row) => row.id === draft.activeSummaryId);
            return summary ? [{ cursorId: summary.summarizedUpToId }] : [];
          },
        };
        return query;
      },
      insert: (table: unknown) => ({
        values: (value: Record<string, unknown>) => {
          const returning = async () => {
            if (table === conversationSummaries) {
              const row = {
                id: Math.max(0, ...draft.summaries.map((summary) => summary.id)) + 1,
                ...value,
              } as SummaryRow;
              draft.summaries.push(row);
              return [{ id: row.id }];
            }
            if (draft.activeSummaryId !== null) return [];
            draft.activeSummaryId = value["activeSummaryId"] as number;
            return [{ activeSummaryId: draft.activeSummaryId }];
          };
          return {
            returning,
            onConflictDoNothing: () => ({ returning }),
          };
        },
      }),
      update: (table: unknown) => ({
        set: (value: Record<string, unknown>) => ({
          where: () => ({
            returning: async () => {
              if (table !== conversationCompactionState || options?.loseUpdateRace) return [];
              draft.activeSummaryId = value["activeSummaryId"] as number;
              return [{ activeSummaryId: draft.activeSummaryId }];
            },
          }),
        }),
      }),
      delete: (table: unknown) => ({
        where: () => ({
          returning: async () => {
            if (table !== conversationSummaries) return [];
            const retained = retainedConversationSummaryIds(
              [...draft.summaries].sort((a, b) => b.id - a.id).map((row) => row.id),
              draft.activeSummaryId,
            );
            const deleted = draft.summaries.filter((row) => !retained.includes(row.id));
            draft.summaries = draft.summaries.filter((row) => retained.includes(row.id));
            return deleted.map(({ id }) => ({ id }));
          },
        }),
      }),
    };
  }

  const db = {
    transaction: async (
      callback: (tx: ReturnType<typeof createTransaction>) => Promise<unknown>,
    ) => {
      const draft = {
        summaries: state.summaries.map((row) => ({ ...row })),
        activeSummaryId: state.activeSummaryId,
        sourceMessageIds: [...state.sourceMessageIds],
      };
      const result = await callback(createTransaction(draft));
      state.summaries = draft.summaries;
      state.activeSummaryId = draft.activeSummaryId;
      return result;
    },
  } as unknown as Database;

  return { db, state };
}

const baseParams = {
  botId: "00000000-0000-4000-8000-000000000017",
  chatId: 42,
  oldCursorId: 0,
  newCursorId: 10,
  summaryText: "Summary",
  messageCount: 10,
  sourceMessageIds: Array.from({ length: 10 }, (_, index) => index + 1),
};

describe("ConversationStore.commitCompaction", () => {
  it("atomically creates the first active cursor without deleting raw rows", async () => {
    const { db, state } = createCommitDb();
    const store = new ConversationStore(db);

    await expect(
      store.commitCompaction({ ...baseParams, expectedActiveSummaryId: null }),
    ).resolves.toBe(true);

    expect(state.activeSummaryId).toBe(1);
    expect(state.summaries).toEqual([
      expect.objectContaining({
        previousSummarizedUpToId: 0,
        summarizedUpToId: 10,
        messageCount: 10,
      }),
    ]);
  });

  it("keeps the active cumulative snapshot and three recent versions", async () => {
    const summaries = Array.from({ length: 7 }, (_, index) => ({
      id: index + 1,
      summarizedUpToId: 0,
    }));
    const { db, state } = createCommitDb({ summaries, activeSummaryId: 7 });
    const store = new ConversationStore(db);

    await expect(
      store.commitCompaction({ ...baseParams, expectedActiveSummaryId: 7 }),
    ).resolves.toBe(true);

    expect(state.activeSummaryId).toBe(8);
    expect(state.summaries.map((summary) => summary.id)).toEqual([5, 6, 7, 8]);
  });

  it("rolls back the summary when the expected active cursor is stale", async () => {
    const { db, state } = createCommitDb({
      summaries: [{ id: 3, summarizedUpToId: 12 }],
      activeSummaryId: 3,
      currentSelectionMissing: true,
    });
    const store = new ConversationStore(db);

    await expect(
      store.commitCompaction({ ...baseParams, expectedActiveSummaryId: 2 }),
    ).resolves.toBe(false);

    expect(state.activeSummaryId).toBe(3);
    expect(state.summaries).toHaveLength(1);
  });

  it("rejects a first summary when its fixed source range is no longer complete", async () => {
    const { db, state } = createCommitDb({ sourceMessageIds: [1, 2, 4, 5, 6, 7, 8, 9, 10] });
    const store = new ConversationStore(db);

    await expect(
      store.commitCompaction({ ...baseParams, expectedActiveSummaryId: null }),
    ).resolves.toBe(false);

    expect(state.activeSummaryId).toBeNull();
    expect(state.summaries).toHaveLength(0);
  });

  it("rolls back when another writer wins after the current cursor check", async () => {
    const { db, state } = createCommitDb({
      summaries: [{ id: 3, summarizedUpToId: 5 }],
      activeSummaryId: 3,
      loseUpdateRace: true,
    });
    const store = new ConversationStore(db);

    await expect(
      store.commitCompaction({ ...baseParams, oldCursorId: 5, expectedActiveSummaryId: 3 }),
    ).resolves.toBe(false);

    expect(state.activeSummaryId).toBe(3);
    expect(state.summaries).toHaveLength(1);
  });

  it("refuses to move an active cursor backwards", async () => {
    const { db, state } = createCommitDb({
      summaries: [{ id: 3, summarizedUpToId: 20 }],
      activeSummaryId: 3,
    });
    const store = new ConversationStore(db);

    await expect(
      store.commitCompaction({ ...baseParams, oldCursorId: 5, expectedActiveSummaryId: 3 }),
    ).resolves.toBe(false);

    expect(state.activeSummaryId).toBe(3);
    expect(state.summaries).toHaveLength(1);
  });
});

describe("conversation summary versions", () => {
  it("protects a legacy active snapshot outside the recent versions", () => {
    expect(retainedConversationSummaryIds([10, 9, 8, 7], 2)).toEqual([10, 9, 8, 2]);
    expect(retainedConversationSummaryIds([10, 9, 8, 7], 10)).toEqual([9, 8, 7, 10]);
    expect(retainedConversationSummaryIds([10, 9, 8, 7], null)).toEqual([10, 9, 8]);
  });

  function createEditDb(options?: { activeId?: number | null; loseRace?: boolean }) {
    const state = {
      activeId: options?.activeId === undefined ? 5 : options.activeId,
      summaries: [
        {
          id: 5,
          botId: baseParams.botId,
          chatId: baseParams.chatId,
          content: "Earlier summary",
          previousSummarizedUpToId: 4,
          summarizedUpToId: 10,
          messageCount: 6,
          createdAt: new Date("2026-09-23T00:00:00Z"),
        },
      ],
    };
    const db = {
      transaction: async (callback: (tx: unknown) => Promise<unknown>) => {
        const draft = {
          activeId: state.activeId,
          summaries: state.summaries.map((row) => ({ ...row })),
        };
        let selectedTable: unknown;
        let summaryReads = 0;
        const query = {
          from: (table: unknown) => {
            selectedTable = table;
            return query;
          },
          innerJoin: () => query,
          where: () => query,
          orderBy: () => query,
          limit: () => {
            if (selectedTable === conversationSummaries) {
              summaryReads++;
              const rows = summaryReads === 1 ? draft.summaries.map(({ id }) => ({ id })) : [];
              return Promise.resolve(rows);
            }
            return { for: query.for };
          },
          for: async () =>
            selectedTable === conversationCompactionState && draft.activeId !== null
              ? draft.summaries.filter((row) => row.id === draft.activeId)
              : [],
        };
        const tx = {
          select: () => query,
          insert: () => ({
            values: (value: Record<string, unknown>) => ({
              returning: async () => {
                const row = {
                  ...draft.summaries[0]!,
                  ...value,
                  id: 6,
                  createdAt: new Date("2026-09-24T00:00:00Z"),
                };
                draft.summaries.push(row);
                return [{ id: row.id, createdAt: row.createdAt }];
              },
            }),
          }),
          update: () => ({
            set: (value: Record<string, unknown>) => ({
              where: () => ({
                returning: async () => {
                  if (options?.loseRace) return [];
                  draft.activeId = value["activeSummaryId"] as number;
                  return [{ activeSummaryId: draft.activeId }];
                },
              }),
            }),
          }),
        };
        const result = await callback(tx);
        state.activeId = draft.activeId;
        state.summaries = draft.summaries;
        return result;
      },
    } as unknown as Database;
    return { db, state };
  }

  it("edits the active snapshot as a new version without advancing the cursor", async () => {
    const { db, state } = createEditDb();
    const result = await new ConversationStore(db).editActiveConversationSummary({
      botId: baseParams.botId,
      chatId: baseParams.chatId,
      expectedActiveSummaryId: 5,
      content: "Corrected summary",
    });
    expect(result).toEqual({ id: 6, createdAt: "2026-09-24T00:00:00.000Z" });
    expect(state.activeId).toBe(6);
    expect(state.summaries[0]?.content).toBe("Earlier summary");
    expect(state.summaries[1]).toMatchObject({
      content: "Corrected summary",
      previousSummarizedUpToId: 4,
      summarizedUpToId: 10,
      messageCount: 6,
    });
  });

  it.each([
    { activeId: 7, loseRace: false },
    { activeId: 5, loseRace: true },
    { activeId: null, loseRace: false },
  ])("rejects stale, racing, or invalidated active snapshots: %j", async (options) => {
    const { db, state } = createEditDb(options);
    await expect(
      new ConversationStore(db).editActiveConversationSummary({
        botId: baseParams.botId,
        chatId: baseParams.chatId,
        expectedActiveSummaryId: 5,
        content: "Should not persist",
      }),
    ).resolves.toBeNull();
    expect(state.activeId).toBe(options.activeId);
    expect(state.summaries).toHaveLength(1);
  });
});

function createDeleteDb(options: { cursorId: number; messageExists?: boolean }) {
  const state = {
    activeSummaryId: 3 as number | null,
    messageExists: options.messageExists ?? true,
  };
  const tx = {
    select: () => {
      const query = {
        from: () => query,
        innerJoin: () => query,
        where: () => query,
        limit: () => query,
        for: async () =>
          state.activeSummaryId === null
            ? []
            : [{ summaryId: state.activeSummaryId, cursorId: options.cursorId }],
      };
      return query;
    },
    delete: (table: unknown) => ({
      where: () => {
        if (table === conversationCompactionState) {
          state.activeSummaryId = null;
          return Promise.resolve();
        }
        return {
          returning: async () => {
            if (!state.messageExists) return [];
            state.messageExists = false;
            return [{ id: 1 }];
          },
        };
      },
    }),
  };
  const db = {
    transaction: (callback: (transaction: typeof tx) => Promise<unknown>) => callback(tx),
  } as unknown as Database;
  return { db, state };
}

describe("ConversationStore.deleteMessage", () => {
  it("invalidates the active summary when deleting a summarized source row", async () => {
    const { db, state } = createDeleteDb({ cursorId: 10 });
    const store = new ConversationStore(db);

    await expect(store.deleteMessage(baseParams.botId, baseParams.chatId, 10)).resolves.toBe(true);

    expect(state.activeSummaryId).toBeNull();
  });

  it("keeps the active summary when deleting a row after its cursor", async () => {
    const { db, state } = createDeleteDb({ cursorId: 10 });
    const store = new ConversationStore(db);

    await expect(store.deleteMessage(baseParams.botId, baseParams.chatId, 11)).resolves.toBe(true);

    expect(state.activeSummaryId).toBe(3);
  });

  it("keeps the active summary when the requested source row does not exist", async () => {
    const { db, state } = createDeleteDb({ cursorId: 10, messageExists: false });
    const store = new ConversationStore(db);

    await expect(store.deleteMessage(baseParams.botId, baseParams.chatId, 10)).resolves.toBe(false);

    expect(state.activeSummaryId).toBe(3);
  });
});

describe("ConversationStore.completeTurn", () => {
  it("preserves source metadata while completing and linking a logical turn", async () => {
    const state: { meta: Record<string, unknown> } = {
      meta: { tgMessageId: 11, publicGroupHistory: true, turnState: "pending" },
    };
    const tx = {
      select: () => {
        const query = {
          from: () => query,
          where: () => query,
          orderBy: () => query,
          for: async () => [{ id: 101, sourceKey: "telegram:11:user", meta: state.meta }],
        };
        return query;
      },
      update: () => ({
        set: (values: { meta: typeof state.meta }) => ({
          where: async () => {
            state.meta = values.meta;
          },
        }),
      }),
    };
    const db = {
      transaction: async <T>(operation: (transaction: typeof tx) => Promise<T>) => operation(tx),
    } as unknown as Database;
    const store = new ConversationStore(db);

    await expect(
      store.completeTurn(baseParams.botId, baseParams.chatId, "telegram:11:user", 101),
    ).resolves.toBe(true);

    expect(state.meta).toEqual({
      tgMessageId: 11,
      publicGroupHistory: true,
      turnState: "complete",
      turnOrderId: 101,
    });
  });

  it("completes every source row in one transaction", async () => {
    const rows = [
      {
        id: 101,
        sourceKey: "telegram:11:user",
        meta: { tgMessageId: 11, turnState: "pending" },
      },
      {
        id: 102,
        sourceKey: "telegram:12:user",
        meta: { tgMessageId: 12, turnState: "pending" },
      },
    ];
    const updates: Array<Record<string, unknown>> = [];
    let transactionCount = 0;
    let transactionOpen = false;
    const tx = {
      select: () => {
        const query = {
          from: () => query,
          where: () => query,
          orderBy: () => query,
          for: async () => {
            expect(transactionOpen).toBe(true);
            return rows;
          },
        };
        return query;
      },
      update: () => ({
        set: (values: { meta: Record<string, unknown> }) => ({
          where: async () => {
            expect(transactionOpen).toBe(true);
            updates.push(values.meta);
          },
        }),
      }),
    };
    const db = {
      transaction: async <T>(operation: (transaction: typeof tx) => Promise<T>) => {
        transactionCount++;
        transactionOpen = true;
        try {
          return await operation(tx);
        } finally {
          transactionOpen = false;
        }
      },
    } as unknown as Database;
    const store = new ConversationStore(db);

    await expect(
      store.completeTurns(
        baseParams.botId,
        baseParams.chatId,
        ["telegram:11:user", "telegram:12:user"],
        101,
      ),
    ).resolves.toBe(true);

    expect(transactionCount).toBe(1);
    expect(updates).toEqual([
      { tgMessageId: 11, turnState: "complete", turnOrderId: 101 },
      { tgMessageId: 12, turnState: "complete", turnOrderId: 101 },
    ]);
  });

  it("completes surviving rows and reports failure when any source row is missing", async () => {
    const updates: Array<Record<string, unknown>> = [];
    const tx = {
      select: () => {
        const query = {
          from: () => query,
          where: () => query,
          orderBy: () => query,
          for: async () => [
            {
              id: 101,
              sourceKey: "telegram:11:user",
              meta: { tgMessageId: 11, turnState: "pending" },
            },
          ],
        };
        return query;
      },
      update: () => ({
        set: (values: { meta: Record<string, unknown> }) => ({
          where: async () => {
            updates.push(values.meta);
          },
        }),
      }),
    };
    const db = {
      transaction: async <T>(operation: (transaction: typeof tx) => Promise<T>) => operation(tx),
    } as unknown as Database;
    const store = new ConversationStore(db);

    await expect(
      store.completeTurns(
        baseParams.botId,
        baseParams.chatId,
        ["telegram:11:user", "telegram:12:user"],
        101,
      ),
    ).resolves.toBe(false);
    expect(updates).toEqual([{ tgMessageId: 11, turnState: "complete", turnOrderId: 101 }]);
  });

  it("recovers every pending turn for a bot without replacing other metadata", async () => {
    const dialect = new PgDialect();
    let setSql = "";
    let whereSql = "";
    const db = {
      update: (table: unknown) => {
        expect(table).toBe(conversationMessages);
        return {
          set: (values: { meta: SQL }) => {
            setSql = dialect.sqlToQuery(values.meta).sql;
            return {
              where: (condition: SQL) => {
                whereSql = dialect.sqlToQuery(condition).sql;
                return {
                  returning: async () => [{ id: 101 }, { id: 104 }],
                };
              },
            };
          },
        };
      },
    } as unknown as Database;
    const store = new ConversationStore(db);

    await expect(store.recoverPendingTurns(baseParams.botId)).resolves.toBe(2);

    expect(setSql).toContain("jsonb_set");
    expect(setSql).toContain("turnState");
    expect(whereSql).toContain("bot_id");
    expect(whereSql).toContain("turnState");
  });
});

function createCandidateDb(
  messages: Array<{
    id: number;
    role: string;
    content: string;
    userName: string | null;
    historyOrderId?: number;
    turnState?: "pending" | "complete";
    meta?: Record<string, unknown> | null;
  }>,
) {
  const state: {
    cursorId: number;
    retainedOrderId?: number;
    pendingOrderId?: number;
  } = { cursorId: 0 };
  const dialect = new PgDialect();
  const orderId = (message: (typeof messages)[number]) => message.historyOrderId ?? message.id;
  const db = {
    select: (selection: Record<string, unknown>) => {
      let limit = Number.POSITIVE_INFINITY;
      let offset = 0;
      let whereSql = "";
      const query = {
        from: () => query,
        innerJoin: () => query,
        where: (expression: SQL) => {
          whereSql = dialect.sqlToQuery(expression).sql;
          return query;
        },
        orderBy: () => query,
        limit: (value: number) => {
          limit = value;
          return query;
        },
        offset: (value: number) => {
          offset = value;
          return query;
        },
        // oxlint-disable-next-line unicorn/no-thenable -- Drizzle queries are intentionally awaitable.
        then: <TResult1 = unknown[], TResult2 = never>(
          onfulfilled?: ((value: unknown[]) => TResult1 | PromiseLike<TResult1>) | null,
          onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
        ): PromiseLike<TResult1 | TResult2> => {
          let rows: unknown[];
          if ("summaryId" in selection) {
            state.retainedOrderId = undefined;
            state.pendingOrderId = undefined;
            rows =
              state.cursorId === 0
                ? []
                : [{ summaryId: 7, cursorId: state.cursorId, content: "Prior summary" }];
          } else if ("content" in selection) {
            const upperOrderId =
              state.retainedOrderId === undefined
                ? state.pendingOrderId
                : state.pendingOrderId === undefined
                  ? state.retainedOrderId
                  : Math.min(state.retainedOrderId, state.pendingOrderId);
            rows = messages
              .filter(
                (message) =>
                  orderId(message) > state.cursorId &&
                  (upperOrderId === undefined || orderId(message) < upperOrderId),
              )
              .sort((left, right) => orderId(left) - orderId(right) || left.id - right.id)
              .map((message) => ({ ...message, historyOrderId: orderId(message) }))
              .slice(0, limit);
          } else if (whereSql.includes("turnState")) {
            const pending = messages
              .filter(
                (message) => orderId(message) > state.cursorId && message.turnState === "pending",
              )
              .sort((left, right) => orderId(left) - orderId(right) || left.id - right.id)[0];
            state.pendingOrderId = pending === undefined ? undefined : orderId(pending);
            rows = pending ? [{ historyOrderId: orderId(pending) }] : [];
          } else {
            const activeRows = messages
              .filter((message) => orderId(message) > state.cursorId)
              .sort((left, right) => orderId(right) - orderId(left) || right.id - left.id);
            const retained = activeRows[offset];
            state.retainedOrderId = retained === undefined ? undefined : orderId(retained);
            rows = retained ? [{ historyOrderId: orderId(retained) }] : [];
          }
          return Promise.resolve(rows).then(onfulfilled, onrejected);
        },
      };
      return query;
    },
  } as unknown as Database;
  return { db, state };
}

describe("ConversationStore.getCompactionCandidate", () => {
  it("advances a long backlog in bounded contiguous batches without crossing the recent window", async () => {
    const recentCount = 3;
    const backlogCount = COMPACTION_MAX_BATCH_MESSAGES + 5;
    const messages = Array.from({ length: backlogCount + recentCount }, (_, index) => ({
      id: index + 1,
      role: "user",
      content: `message-${index + 1}`,
      userName: "Alice",
    }));
    const { db, state } = createCandidateDb(messages);
    const store = new ConversationStore(db);

    const first = await store.getCompactionCandidate(
      baseParams.botId,
      baseParams.chatId,
      recentCount,
    );
    expect(first?.oldCursorId).toBe(0);
    expect(first?.messages).toHaveLength(COMPACTION_MAX_BATCH_MESSAGES);
    expect(first?.newCursorId).toBe(COMPACTION_MAX_BATCH_MESSAGES);

    state.cursorId = first!.newCursorId;
    const second = await store.getCompactionCandidate(
      baseParams.botId,
      baseParams.chatId,
      recentCount,
    );
    expect(second?.oldCursorId).toBe(first?.newCursorId);
    expect(second?.messages.map((message) => message.id)).toEqual(
      Array.from({ length: 5 }, (_, index) => COMPACTION_MAX_BATCH_MESSAGES + index + 1),
    );
    expect(second?.newCursorId).toBe(backlogCount);

    state.cursorId = second!.newCursorId;
    await expect(
      store.getCompactionCandidate(baseParams.botId, baseParams.chatId, recentCount),
    ).resolves.toBeNull();
  });

  it("bounds an oversized first message while still advancing the cursor", async () => {
    const { db } = createCandidateDb([
      { id: 1, role: "user", content: "x".repeat(500_000), userName: "Alice" },
    ]);
    const store = new ConversationStore(db);

    const candidate = await store.getCompactionCandidate(baseParams.botId, baseParams.chatId, 0);

    expect(candidate?.messages).toHaveLength(1);
    expect(candidate?.newCursorId).toBe(1);
    expect(candidate?.messages[0]?.content.length).toBeLessThan(COMPACTION_MAX_BATCH_JSON_CHARS);
    expect(candidate?.messages[0]?.content).toContain("truncated for compaction");
  });

  it("keeps recent complete turns while compacting older interleaved source rows", async () => {
    const { db } = createCandidateDb([
      {
        id: 1,
        role: "user",
        content: "user-a",
        userName: "Alice",
        historyOrderId: 1,
        meta: { forwardOrigin: { type: "hidden_user", name: "Forwarded Alice" } },
      },
      { id: 2, role: "user", content: "user-b", userName: "Bob", historyOrderId: 2 },
      { id: 3, role: "assistant", content: "assistant-a", userName: null, historyOrderId: 1 },
      { id: 4, role: "assistant", content: "assistant-b", userName: null, historyOrderId: 2 },
    ]);
    const store = new ConversationStore(db);

    const candidate = await store.getCompactionCandidate(baseParams.botId, baseParams.chatId, 2);

    expect(candidate?.messages.map((message) => message.content)).toEqual([
      "user-a",
      "assistant-a",
    ]);
    expect(candidate?.sourceMessageIds).toEqual([1, 3]);
    expect(candidate?.newCursorId).toBe(1);
    expect(candidate?.messages[0]?.forwardOrigin).toEqual({
      type: "hidden_user",
      name: "Forwarded Alice",
    });
  });

  it("preserves relay attribution in compaction without changing stored body", async () => {
    const { db } = createCandidateDb([
      {
        id: 1,
        role: "context",
        content: "relay body",
        userName: "Alice",
        historyOrderId: 1,
        meta: { source: "cosinside", initiatorTelegramId: 42, initiatorName: "Alice" },
      },
      { id: 2, role: "user", content: "later", userName: "Bob", historyOrderId: 2 },
    ]);
    const candidate = await new ConversationStore(db).getCompactionCandidate(
      baseParams.botId,
      baseParams.chatId,
      1,
    );
    expect(candidate?.messages[0]).toMatchObject({
      role: "context",
      content: "relay body",
      relayOrigin: { source: "cosinside", initiatorTelegramId: 42, initiatorName: "Alice" },
    });
  });

  it("does not advance compaction across a pending reply turn", async () => {
    const { db } = createCandidateDb([
      {
        id: 1,
        role: "user",
        content: "complete-a",
        userName: "Alice",
        historyOrderId: 1,
        turnState: "complete",
      },
      {
        id: 2,
        role: "user",
        content: "pending-b",
        userName: "Bob",
        historyOrderId: 2,
        turnState: "pending",
      },
      {
        id: 3,
        role: "user",
        content: "complete-c",
        userName: "Carol",
        historyOrderId: 3,
        turnState: "complete",
      },
    ]);
    const store = new ConversationStore(db);

    const candidate = await store.getCompactionCandidate(baseParams.botId, baseParams.chatId, 0);

    expect(candidate?.messages.map((message) => message.content)).toEqual(["complete-a"]);
    expect(candidate?.sourceMessageIds).toEqual([1]);
    expect(candidate?.newCursorId).toBe(1);
  });
});

function createCleanupDb(params: {
  botId: string;
  cutoffDate: Date;
  summaries: Array<{ id: number; botId: string; createdAt: Date }>;
  activeStates: Array<{ botId: string; chatId: number; summaryId: number }>;
  messages: Array<{ id: number; botId: string; chatId: number; createdAt: Date }>;
}) {
  const state = {
    summaries: params.summaries.map((row) => ({ ...row })),
    activeStates: params.activeStates.map((row) => ({ ...row })),
    messages: params.messages.map((row) => ({ ...row })),
  };

  const tx = {
    selectDistinct: () => {
      const query = {
        from: () => query,
        where: async () =>
          [
            ...new Set(
              state.messages
                .filter((row) => row.botId === params.botId && row.createdAt < params.cutoffDate)
                .map((row) => row.chatId),
            ),
          ].map((chatId) => ({ chatId })),
      };
      return query;
    },
    select: () => {
      const query = {
        from: () => query,
        innerJoin: () => query,
        where: () => query,
        for: async () =>
          state.activeStates
            .filter((active) => {
              if (active.botId !== params.botId) return false;
              const summary = state.summaries.find((row) => row.id === active.summaryId);
              return summary !== undefined && summary.createdAt < params.cutoffDate;
            })
            .map((active) => ({ summaryId: active.summaryId })),
      };
      return query;
    },
    delete: (table: unknown) => ({
      where: async () => {
        if (table === conversationMessages) {
          state.messages = state.messages.filter(
            (row) => row.botId !== params.botId || row.createdAt >= params.cutoffDate,
          );
          return;
        }
        if (table === conversationCompactionState) {
          state.activeStates = state.activeStates.filter((active) => {
            if (active.botId !== params.botId) return true;
            const summary = state.summaries.find((row) => row.id === active.summaryId);
            return summary === undefined || summary.createdAt >= params.cutoffDate;
          });
          return;
        }
        if (table === conversationSummaries) {
          const expiredIds = new Set(
            state.summaries
              .filter((row) => row.botId === params.botId && row.createdAt < params.cutoffDate)
              .map((row) => row.id),
          );
          if (state.activeStates.some((active) => expiredIds.has(active.summaryId))) {
            throw new Error("active summary foreign key violation");
          }
          state.summaries = state.summaries.filter((row) => !expiredIds.has(row.id));
        }
      },
    }),
    update: () => ({
      set: () => ({
        where: async () => undefined,
      }),
    }),
  };
  const db = {
    transaction: (callback: (transaction: typeof tx) => Promise<unknown>) => callback(tx),
  } as unknown as Database;
  return { db, state };
}

describe("ConversationStore.cleanup", () => {
  it("expires active and inactive data for one bot while preserving fresh active data", async () => {
    const now = new Date("2026-07-18T12:00:00.000Z");
    const old = new Date("2026-05-01T00:00:00.000Z");
    const fresh = new Date("2026-07-17T00:00:00.000Z");
    const otherBotId = "7842628c-fe86-464e-9628-801966bf3098";
    const cutoffDate = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
    const { db, state } = createCleanupDb({
      botId: baseParams.botId,
      cutoffDate,
      summaries: [
        { id: 1, botId: baseParams.botId, createdAt: old },
        { id: 2, botId: baseParams.botId, createdAt: old },
        { id: 3, botId: baseParams.botId, createdAt: fresh },
        { id: 4, botId: otherBotId, createdAt: old },
      ],
      activeStates: [
        { botId: baseParams.botId, chatId: 1, summaryId: 1 },
        { botId: baseParams.botId, chatId: 2, summaryId: 3 },
        { botId: otherBotId, chatId: 3, summaryId: 4 },
      ],
      messages: [
        { id: 1, botId: baseParams.botId, chatId: 1, createdAt: old },
        { id: 2, botId: baseParams.botId, chatId: 2, createdAt: fresh },
        { id: 3, botId: otherBotId, chatId: 3, createdAt: old },
      ],
    });
    const store = new ConversationStore(db);
    vi.spyOn(Date, "now").mockReturnValue(now.getTime());

    await store.cleanup(baseParams.botId, 30);

    expect(state.summaries.map((row) => row.id)).toEqual([3, 4]);
    expect(state.activeStates.map((row) => row.summaryId)).toEqual([3, 4]);
    expect(state.messages.map((row) => row.id)).toEqual([2, 3]);
  });
});

type HistoryLimitRow = { id: number; orderId?: number; turnState?: "pending" | "complete" };

function createHistoryLimitDb(rows: HistoryLimitRow[]) {
  const state = { rows: [...rows], rawHistoryIntact: true };
  const dialect = new PgDialect();
  const orderIdOf = (row: HistoryLimitRow) => row.orderId ?? row.id;
  const pendingFence = () => {
    const pending = state.rows
      .filter((row) => row.turnState === "pending")
      .map(orderIdOf)
      .sort((left, right) => left - right);
    return pending[0];
  };
  const tx = {
    execute: async () => undefined,
    select: (selection: Record<string, unknown>) => {
      let limit = Number.POSITIVE_INFINITY;
      let grouped = false;
      const query = {
        from: () => query,
        where: () => query,
        groupBy: () => {
          grouped = true;
          return query;
        },
        orderBy: () => query,
        limit: (value: number) => {
          limit = value;
          return query;
        },
        // oxlint-disable-next-line unicorn/no-thenable -- Drizzle queries are intentionally awaitable.
        then: <TResult1 = unknown[], TResult2 = never>(
          onfulfilled?: ((value: unknown[]) => TResult1 | PromiseLike<TResult1>) | null,
          onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
        ): PromiseLike<TResult1 | TResult2> => {
          const fence = pendingFence();
          let result: unknown[];
          if (grouped) {
            const totals = new Map<number, number>();
            for (const row of state.rows) {
              const orderId = orderIdOf(row);
              if (fence !== undefined && orderId >= fence) continue;
              totals.set(orderId, (totals.get(orderId) ?? 0) + 1);
            }
            result = [...totals.entries()]
              .sort((left, right) => left[0] - right[0])
              .slice(0, limit)
              .map(([historyOrderId, total]) => ({ historyOrderId, total }));
          } else if ("historyOrderId" in selection) {
            result = fence === undefined ? [] : [{ historyOrderId: fence }];
          } else {
            result = [{ total: state.rows.length }];
          }
          return Promise.resolve(result).then(onfulfilled, onrejected);
        },
      };
      return query;
    },
    delete: () => ({
      where: (expression: SQL) => ({
        returning: async () => {
          const cutoff = Number(dialect.sqlToQuery(expression).params.at(-1));
          const deleted = state.rows.filter((row) => orderIdOf(row) <= cutoff);
          state.rows = state.rows.filter((row) => orderIdOf(row) > cutoff);
          return deleted.map((row) => ({ id: row.id }));
        },
      }),
    }),
    update: () => ({
      set: (values: { rawHistoryIntact?: boolean }) => ({
        where: async () => {
          if (values.rawHistoryIntact !== undefined) {
            state.rawHistoryIntact = values.rawHistoryIntact;
          }
        },
      }),
    }),
  };
  const db = {
    transaction: (callback: (transaction: typeof tx) => Promise<unknown>) => callback(tx),
  } as unknown as Database;
  return { db, state };
}

describe("ConversationStore.enforceHistoryLimit", () => {
  it("leaves raw history unlimited when the configured limit is zero", async () => {
    const transaction = vi.fn();
    const store = new ConversationStore({ transaction } as unknown as Database);

    await expect(
      store.enforceHistoryLimit(baseParams.botId, baseParams.chatId, 0),
    ).resolves.toEqual({
      countBefore: 0,
      countAfter: 0,
      limit: 0,
      warningThreshold: 0,
      prunedCount: 0,
      warning: false,
    });
    expect(transaction).not.toHaveBeenCalled();
  });

  it("prunes the oldest rows back to the 80% warning threshold at the hard limit", async () => {
    const { db, state } = createHistoryLimitDb(
      Array.from({ length: 10 }, (_, index) => ({ id: index + 1 })),
    );
    const store = new ConversationStore(db);

    const result = await store.enforceHistoryLimit(baseParams.botId, baseParams.chatId, 10);

    expect(result).toEqual({
      countBefore: 10,
      countAfter: 8,
      limit: 10,
      warningThreshold: 8,
      prunedCount: 2,
      warning: true,
    });
    expect(state.rows.map((row) => row.id)).toEqual([3, 4, 5, 6, 7, 8, 9, 10]);
    expect(state.rawHistoryIntact).toBe(false);
  });

  it("absorbs a batch overshoot and still returns to the configured warning threshold", async () => {
    const { db, state } = createHistoryLimitDb(
      Array.from({ length: 13 }, (_, index) => ({ id: index + 1 })),
    );
    const store = new ConversationStore(db);

    const result = await store.enforceHistoryLimit(baseParams.botId, baseParams.chatId, 10);

    expect(result.prunedCount).toBe(5);
    expect(result.countAfter).toBe(8);
    expect(state.rows.map((row) => row.id)).toEqual([6, 7, 8, 9, 10, 11, 12, 13]);
  });

  it("prunes complete logical turns instead of splitting rows that share a turn order", async () => {
    const { db, state } = createHistoryLimitDb([
      { id: 1 },
      { id: 2 },
      { id: 3 },
      { id: 4 },
      { id: 5, orderId: 1 },
      { id: 6, orderId: 2 },
    ]);
    const store = new ConversationStore(db);

    const result = await store.enforceHistoryLimit(baseParams.botId, baseParams.chatId, 6);

    expect(result.prunedCount).toBe(2);
    expect(result.countAfter).toBe(4);
    expect(state.rows.map((row) => row.id)).toEqual([2, 3, 4, 6]);
  });

  it("stops pruning at the oldest pending turn even when the limit stays exceeded", async () => {
    const { db, state } = createHistoryLimitDb([
      { id: 1 },
      { id: 2, turnState: "pending" },
      ...Array.from({ length: 8 }, (_, index) => ({ id: index + 3 })),
      { id: 11, orderId: 2 },
    ]);
    const store = new ConversationStore(db);

    const result = await store.enforceHistoryLimit(baseParams.botId, baseParams.chatId, 10);

    expect(result.countBefore).toBe(11);
    expect(result.prunedCount).toBe(1);
    expect(result.countAfter).toBe(10);
    expect(state.rows.map((row) => row.id)).toEqual([2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
  });
});

function createMessageWriteDb() {
  const state = { inserted: [] as Array<Record<string, unknown>> };
  const db = {
    insert: () => ({
      values: (rows: Array<Record<string, unknown>>) => {
        let ignoreConflicts = false;
        const returning = async () => {
          const seenSourceKeys = new Set(
            state.inserted.map((row) => row["sourceKey"]).filter((key) => typeof key === "string"),
          );
          const inserted = rows.filter((row) => {
            const sourceKey = row["sourceKey"];
            if (!ignoreConflicts || typeof sourceKey !== "string") return true;
            if (seenSourceKeys.has(sourceKey)) return false;
            seenSourceKeys.add(sourceKey);
            return true;
          });
          state.inserted.push(...inserted);
          return inserted.map((row, index) => ({
            id: index + 1,
            role: row["role"],
            content: row["content"],
          }));
        };
        return {
          returning,
          onConflictDoNothing: () => {
            ignoreConflicts = true;
            return { returning };
          },
        };
      },
    }),
  } as unknown as Database;
  return { db, state };
}

describe("ConversationStore.addMessages", () => {
  it("drops empty and display-only history while bounding durable tool traces", async () => {
    const { db, state } = createMessageWriteDb();
    const store = new ConversationStore(db);

    const persisted = await store.addMessages([
      { botId: baseParams.botId, chatId: baseParams.chatId, role: "assistant", content: "   " },
      {
        botId: baseParams.botId,
        chatId: baseParams.chatId,
        role: "tool_call",
        content: "send_sticker",
        meta: { toolName: "send_sticker", args: '{"emoji":"🥳"}' },
      },
      {
        botId: baseParams.botId,
        chatId: baseParams.chatId,
        role: "tool_result",
        content: '{"success":true}',
        meta: { toolName: "send_sticker" },
      },
      {
        botId: baseParams.botId,
        chatId: baseParams.chatId,
        role: "tool_call",
        content: "set_timer",
        meta: { toolName: "set_timer", args: "x".repeat(10_000) },
      },
      {
        botId: baseParams.botId,
        chatId: baseParams.chatId,
        role: "tool_result",
        content: "y".repeat(10_000),
        meta: { toolName: "set_timer" },
      },
    ]);

    expect(state.inserted).toHaveLength(2);
    expect(state.inserted.map((row) => row["role"])).toEqual(["tool_call", "tool_result"]);
    expect(
      (state.inserted[0]?.["meta"] as { args: string } | undefined)?.args.length ?? 0,
    ).toBeLessThanOrEqual(2_100);
    expect(String(state.inserted[1]?.["content"]).length).toBeLessThanOrEqual(2_100);
    expect(persisted).toHaveLength(2);
  });

  it("persists each platform source record only once", async () => {
    const { db, state } = createMessageWriteDb();
    const store = new ConversationStore(db);
    const message = {
      botId: baseParams.botId,
      chatId: baseParams.chatId,
      role: "user" as const,
      content: "hello",
      sourceKey: "telegram:42:user",
    };

    await store.addMessages([message, message]);

    expect(state.inserted).toHaveLength(1);
    expect(state.inserted[0]?.["sourceKey"]).toBe("telegram:42:user");
  });

  it("deduplicates a delivered relay without creating a personal continuity projection", async () => {
    const { db, state } = createMessageWriteDb();
    const store = new ConversationStore(db);
    const message = {
      ...baseParams,
      role: "context" as const,
      content: "relay body",
      userId: 42,
      userName: "Alice",
      sourceKey: "telegram:55:cosinside",
      meta: {
        source: "cosinside",
        initiatorTelegramId: 42,
        initiatorName: "Alice",
        tgMessageId: 55,
      },
    };
    await store.addMessage(message);
    await store.addMessage(message);
    expect(state.inserted).toHaveLength(1);
    expect(state.inserted[0]).toMatchObject({
      content: "relay body",
      role: "context",
      userId: 42,
      sourceKey: "telegram:55:cosinside",
    });
    expect(state.inserted[0]?.["userAuthoredContent"]).toBeNull();
  });

  it("persists a separate user-authored projection for cross-chat continuity", async () => {
    const { db, state } = createMessageWriteDb();
    const store = new ConversationStore(db);

    await store.addMessages([
      {
        botId: baseParams.botId,
        chatId: baseParams.chatId,
        role: "user",
        content: "[Reply to Bob: private quote]\nmy answer",
        userAuthoredContent: "my answer",
        userId: 42,
      },
    ]);

    expect(state.inserted[0]).toMatchObject({
      content: "[Reply to Bob: private quote]\nmy answer",
      userAuthoredContent: "my answer",
      userId: 42,
    });
  });
});

describe("ConversationStore.getRecentUserMessagesAcrossChats", () => {
  it("limits at the database boundary and restores selected rows to chronological order", async () => {
    const limit = vi.fn(async () => [
      { id: 12, content: "newest", createdAt: new Date("2026-07-22T00:00:00.000Z") },
      { id: 11, content: "older", createdAt: new Date("2026-07-21T00:00:00.000Z") },
    ]);
    const query = {
      from: () => query,
      where: () => query,
      orderBy: () => query,
      limit,
    };
    const db = {
      select: () => query,
    } as unknown as Database;
    const store = new ConversationStore(db);

    await expect(
      store.getRecentUserMessagesAcrossChats(baseParams.botId, 42, baseParams.chatId, 5),
    ).resolves.toEqual([
      { id: 11, content: "older", createdAt: "2026-07-21T00:00:00.000Z" },
      { id: 12, content: "newest", createdAt: "2026-07-22T00:00:00.000Z" },
    ]);
    expect(limit).toHaveBeenCalledWith(5);
  });

  it("ignores messages persisted after the admission watermark", async () => {
    const rows = [
      { id: 11, content: "older", createdAt: new Date("2026-07-21T00:00:00.000Z") },
      { id: 12, content: "at watermark", createdAt: new Date("2026-07-22T00:00:00.000Z") },
      { id: 13, content: "arrived while queued", createdAt: new Date("2026-07-23T00:00:00.000Z") },
    ];
    const dialect = new PgDialect();
    let whereSql = "";
    let params: unknown[] = [];
    const query = {
      from: () => query,
      where: (expression: SQL) => {
        const compiled = dialect.sqlToQuery(expression);
        whereSql = compiled.sql;
        params = compiled.params;
        return query;
      },
      orderBy: () => query,
      limit: async (value: number) => {
        const bound = whereSql.includes('"id" <=') ? Number(params.at(-1)) : undefined;
        return rows
          .filter((row) => bound === undefined || row.id <= bound)
          .sort((left, right) => right.createdAt.getTime() - left.createdAt.getTime())
          .slice(0, value);
      },
    };
    const store = new ConversationStore({ select: () => query } as unknown as Database);

    await expect(
      store.getRecentUserMessagesAcrossChats(baseParams.botId, 42, baseParams.chatId, 5, 12),
    ).resolves.toEqual([
      { id: 11, content: "older", createdAt: "2026-07-21T00:00:00.000Z" },
      { id: 12, content: "at watermark", createdAt: "2026-07-22T00:00:00.000Z" },
    ]);
    expect(whereSql).toContain('"id" <=');

    await expect(
      store.getRecentUserMessagesAcrossChats(baseParams.botId, 42, baseParams.chatId, 5),
    ).resolves.toHaveLength(3);
    expect(whereSql).not.toContain('"id" <=');
  });
});

describe("ConversationStore.getHistoryWatermark", () => {
  it("reports the newest persisted message id for the bot", async () => {
    const query = {
      from: () => query,
      where: async () => [{ maxId: 42 }],
    };
    const store = new ConversationStore({ select: () => query } as unknown as Database);

    await expect(store.getHistoryWatermark(baseParams.botId)).resolves.toBe(42);
  });

  it("reports no watermark for an empty history", async () => {
    const query = {
      from: () => query,
      where: async () => [{ maxId: null }],
    };
    const store = new ConversationStore({ select: () => query } as unknown as Database);

    await expect(store.getHistoryWatermark(baseParams.botId)).resolves.toBeUndefined();
  });
});

describe("relay history search", () => {
  it.each([undefined, [0.1]])(
    "retains attribution in keyword and hybrid results %j",
    async (queryEmbedding) => {
      const row = {
        id: 1,
        role: "context",
        content: "relay body",
        userName: "Alice",
        chatId: -1001,
        createdAt: new Date(),
        meta: { source: "cosinside", initiatorTelegramId: 42, initiatorName: "Alice" },
      };
      const query = {
        from: () => query,
        where: () => query,
        orderBy: () => query,
        limit: async () => [row],
      };
      const db = { select: () => query } as unknown as Database;
      const results = await new ConversationStore(db).searchMessages(baseParams.botId, {
        query: "relay",
        queryEmbedding,
      });
      expect(results[0]?.content).toContain("cosinside 代发");
      expect(results[0]?.content).toContain("Telegram ID: 42");
      expect(results[0]?.content).toContain("relay body");
      expect(row.content).toBe("relay body");
    },
  );
});

describe("editable assistant history", () => {
  it("scopes durable lookup and update by bot, chat, role and Telegram ID", async () => {
    const scopes: Array<{ sql: string; params: unknown[] }> = [];
    const values: unknown[] = [];
    const query = {
      from: () => query,
      where: (condition: SQL) => {
        scopes.push(new PgDialect().sqlToQuery(condition));
        return query;
      },
      limit: async () => [{ id: 7 }],
      set: (value: unknown) => {
        values.push(value);
        return query;
      },
      returning: async () => [{ id: 7 }],
    };
    const store = new ConversationStore({
      select: () => query,
      update: () => query,
    } as unknown as Database);
    expect(await store.findOwnMessage("bot-a", 42, 12)).toBe(true);
    await store.updateOwnMessage("bot-a", 42, 12, "corrected");
    expect(scopes).toHaveLength(2);
    for (const scope of scopes) {
      expect(scope.params).toEqual(["bot-a", 42, "assistant", "12"]);
      expect(scope.sql).toContain("tgMessageId");
    }
    expect(values).toEqual([{ content: "corrected", embedding: null }]);
  });
  it("does not report synchronization when the history record disappeared", async () => {
    const query = { set: () => query, where: () => query, returning: async () => [] };
    const store = new ConversationStore({ update: () => query } as unknown as Database);
    await expect(store.updateOwnMessage("bot-a", 42, 12, "corrected")).rejects.toThrow(
      "no longer exists",
    );
  });
});
