import {
  conversationCompactionState,
  conversationMessages,
  conversationSummaries,
  type Database,
} from "@cos-tool-bot/database";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  COMPACTION_MAX_BATCH_JSON_CHARS,
  COMPACTION_MAX_BATCH_MESSAGES,
  ConversationStore,
  selectHistoryWithinTokenBudget,
} from "./conversation-store.js";

afterEach(() => {
  vi.restoreAllMocks();
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

  it("uses a compacted summary plus the newest raw tail when history exceeds the budget", () => {
    const largeRows = rows.map((row) => ({ ...row, content: row.content.repeat(100) }));
    const selected = selectHistoryWithinTokenBudget(
      largeRows,
      { cursorId: 10, content: "Earlier history summary ".repeat(100) },
      300,
    );

    expect(selected.trace.completeRawHistory).toBe(false);
    expect(selected.trace.usedSummary).toBe(true);
    expect(selected.trace.degraded).toBe(false);
    expect(selected.messages.at(-1)?.id).toBe(21);
    expect(selected.messages.every((message) => message.id > 10)).toBe(true);
    expect(selected.trace.usedTokens).toBeLessThanOrEqual(300);
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
          limit: async () => {
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

function createCandidateDb(
  messages: Array<{ id: number; role: string; content: string; userName: string | null }>,
) {
  const state = { cursorId: 0, boundaryId: 0, selectCall: 0 };
  const db = {
    select: () => {
      state.selectCall += 1;
      const callType = (state.selectCall - 1) % 3;
      let limit = Number.POSITIVE_INFINITY;
      let offset = 0;
      const query = {
        from: () => query,
        innerJoin: () => query,
        where: () => query,
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
          if (callType === 0) {
            rows =
              state.cursorId === 0
                ? []
                : [{ summaryId: 7, cursorId: state.cursorId, content: "Prior summary" }];
          } else if (callType === 1) {
            const activeRows = messages
              .filter((message) => message.id > state.cursorId)
              .sort((a, b) => b.id - a.id);
            const boundary = activeRows[offset];
            state.boundaryId = boundary?.id ?? 0;
            rows = boundary ? [{ id: boundary.id }] : [];
          } else {
            rows = messages
              .filter((message) => message.id > state.cursorId && message.id <= state.boundaryId)
              .sort((a, b) => a.id - b.id)
              .slice(0, limit);
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
});

function createCleanupDb(params: {
  botId: string;
  cutoffDate: Date;
  summaries: Array<{ id: number; botId: string; createdAt: Date }>;
  activeStates: Array<{ botId: string; chatId: number; summaryId: number }>;
  messages: Array<{ id: number; botId: string; createdAt: Date }>;
}) {
  const state = {
    summaries: params.summaries.map((row) => ({ ...row })),
    activeStates: params.activeStates.map((row) => ({ ...row })),
    messages: params.messages.map((row) => ({ ...row })),
  };

  const tx = {
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
        { id: 1, botId: baseParams.botId, createdAt: old },
        { id: 2, botId: baseParams.botId, createdAt: fresh },
        { id: 3, botId: otherBotId, createdAt: old },
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

function createHistoryLimitDb(messageIds: number[]) {
  const state = { messageIds: [...messageIds] };
  let selectedForDeletion: number[] = [];
  const tx = {
    execute: async () => undefined,
    select: () => {
      let limit = Number.POSITIVE_INFINITY;
      const query = {
        from: () => query,
        where: () => query,
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
          if (limit === Number.POSITIVE_INFINITY) {
            return Promise.resolve([{ total: state.messageIds.length }]).then(
              onfulfilled,
              onrejected,
            );
          }
          selectedForDeletion = state.messageIds.slice(0, limit);
          return Promise.resolve(selectedForDeletion.map((id) => ({ id }))).then(
            onfulfilled,
            onrejected,
          );
        },
      };
      return query;
    },
    delete: () => ({
      where: () => ({
        returning: async () => {
          const selected = new Set(selectedForDeletion);
          const deleted = state.messageIds.filter((id) => selected.has(id));
          state.messageIds = state.messageIds.filter((id) => !selected.has(id));
          return deleted.map((id) => ({ id }));
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
    const { db, state } = createHistoryLimitDb(Array.from({ length: 10 }, (_, index) => index + 1));
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
    expect(state.messageIds).toEqual([3, 4, 5, 6, 7, 8, 9, 10]);
  });

  it("absorbs a batch overshoot and still returns to the configured warning threshold", async () => {
    const { db, state } = createHistoryLimitDb(Array.from({ length: 13 }, (_, index) => index + 1));
    const store = new ConversationStore(db);

    const result = await store.enforceHistoryLimit(baseParams.botId, baseParams.chatId, 10);

    expect(result.prunedCount).toBe(5);
    expect(result.countAfter).toBe(8);
    expect(state.messageIds).toEqual([6, 7, 8, 9, 10, 11, 12, 13]);
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
});
